/**
 * Placing a thread: what it runs under, which machine hosts it and where on
 * that machine it works, settled before a row exists, and then written as one
 * write set - the session, its first input, its entry and the working area it
 * asked for. The machine hears about the working area once that is durable.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AccessMode, SessionSpec } from "@hydra/protocol";
import {
  forbidden,
  Id,
  invalidState,
  nearestSupportedAccessMode,
  SESSION_CONTINUE_FIELDS,
  SessionSpawnInput,
  validation,
  validationOf,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Session,
  type SpawnWorkspace,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { currentStamp, currentUser, requireGrant } from "../actor";
import { mintUuid, nowIso, uuidToString, withTransaction } from "../db";
import { PermissionProfiles, type GrantsError } from "../permissions";
import type { PluginHost } from "../plugins";
import {
  loggedIn,
  NO_PLACEMENT,
  providerRepository,
  resolvedInstance,
  type StoredSnapshot,
} from "../providers";
import { resourceRepository } from "../resources";
import { DRAINING, NO_SUCH_RUNNER, RETIRED, RunnerPresence, runnerRepository } from "../runners";
import {
  continuingSpecOf,
  requireSession,
  SessionService,
  sessionRepository,
  timeoutsFrom,
  validatedOptions,
} from "../sessions";
import { Settings, type SettingError } from "../settings";
import { WorkspaceService } from "../workspaces";
import { Dispatch } from "./dispatch";
import { resumable } from "./resuming";

const ContinueInput = Schema.Struct({ id: Id, ...SESSION_CONTINUE_FIELDS });

export type ContinueInput = Schema.Schema.Type<typeof ContinueInput>;

const decodeSpawn = Schema.decodeUnknownEffect(SessionSpawnInput);
const decodeContinue = Schema.decodeUnknownEffect(ContinueInput);

const NO_SUCH_PROFILE = "no such permission profile";

const NO_SUCH_PROJECT_NAMED = "no such project";

/** Why a session may not fork a session that is bounded by other grants. */
const NOT_ITS_PROFILE = "a session may only continue a session on its own permission profile";

/** The shipped profile a thread takes when the user has chosen none (spec 02 Thread). */
const DEFAULT_PROFILE = "unrestricted";

const DEFAULT_ACCESS_MODE: AccessMode = "approval-required";

/** How either call can refuse. */
type Refusal =
  | Unauthenticated
  | Forbidden
  | Validation
  | SqlError
  | InvalidState
  | SettingError
  | Schema.SchemaError;

/** A spawn reads permission profiles; a fork carries its parent's. */
type PlaceError = Refusal | GrantsError;

/** A fork names the session it forks off, which may not be there. */
type ContinueError = Refusal | NotFound;

/**
 * What it takes to open one session on a machine, whether it is the first of a
 * conversation or a branch off another one's.
 */
interface Placing {
  readonly permissionProfileId: string;
  readonly runnerId: string;
  readonly requestedAccessMode: AccessMode;
  readonly parentSessionId: string | undefined;
  /** Everything the machine is told; its workspace is settled while placing. */
  readonly spec: SessionSpec;
  readonly prompt: string;
  readonly kind: "session.spawned" | "session.continued";
  /** What the audit entry records beyond the new session's own id. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projectId: string | undefined;
  /** Where the session is to work; absent keeps the workspace the spec names. */
  readonly workspace: SpawnWorkspace | undefined;
  /** The GitHub account a session pushes as where its working area names none. */
  readonly fallbackGithubConnectionId: string | undefined;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const rows = yield* sessionRepository;
  const workspaces = yield* WorkspaceService;
  const resources = yield* resourceRepository;
  const instances = yield* providerRepository;
  const resolved = yield* resolvedInstance;
  const runners = yield* runnerRepository;
  const presence = yield* RunnerPresence;
  const profiles = yield* PermissionProfiles;
  const settings = yield* Settings;
  const one = requireSession(rows);
  const resumableNativeSession = yield* resumable;
  const { dispatch } = yield* Dispatch;

  /**
   * Which machine hosts the session, where the caller left it to placement:
   * the first that is online and holds a capability snapshot saying it has
   * this instance's harness and a login for it.
   */
  const placement = (
    snapshots: ReadonlyArray<StoredSnapshot>,
  ): Effect.Effect<StoredSnapshot, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const placeable = yield* runners.placeable();
      const found = snapshots.find(
        (snapshot) => loggedIn(snapshot) && placeable.has(snapshot.runnerId),
      );
      if (found === undefined) return yield* Effect.fail(invalidState(NO_PLACEMENT));
      return found;
    });

  /**
   * The one machine a caller named directly, honoured even where it is
   * reserved, full, or unreachable this moment: read and checked on its own,
   * the way `continue` checks the one machine it is pinned to, rather than
   * filtered through `placeable`, which exists only for the automatic
   * fallback above. Whether it can take the session now is dispatch's to
   * decide; a machine that cannot yet still gets the session queued on it.
   */
  const explicitRunner = (
    runnerId: string,
    snapshots: ReadonlyArray<StoredSnapshot>,
  ): Effect.Effect<StoredSnapshot, InvalidState | Validation | SqlError> =>
    Effect.gen(function* () {
      const found = yield* runners.read(runnerId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(validation([{ path: ["runnerId"], message: NO_SUCH_RUNNER }]));
      }
      const runner = found.value;
      if (runner.lifecycle !== "active") {
        return yield* Effect.fail(
          invalidState(runner.lifecycle === "retired" ? RETIRED : DRAINING),
        );
      }
      const snapshot = snapshots.find((one) => one.runnerId === runnerId && loggedIn(one));
      if (snapshot === undefined) return yield* Effect.fail(invalidState(NO_PLACEMENT));
      return snapshot;
    });

  /** Refuses a permissionProfileId naming no profile, before it is trusted as this session's. */
  const requireProfile = (
    profileId: string,
  ): Effect.Effect<void, Validation | GrantsError | SqlError> =>
    Effect.gen(function* () {
      const found = yield* profiles.getById(profileId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          validation([{ path: ["permissionProfileId"], message: NO_SUCH_PROFILE }]),
        );
      }
    });

  /** The shipped thread default until the user has a `thread.instanceId` (spec 02 Thread). */
  const firstLoggedIn = (): Effect.Effect<string, InvalidState | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      for (const snapshot of yield* instances.snapshots()) {
        if (loggedIn(snapshot)) return snapshot.instanceId;
      }
      return yield* Effect.fail(
        invalidState("no provider instance has a logged-in machine; log in on one first"),
      );
    });

  const threadProfile = (): Effect.Effect<string, InvalidState | GrantsError | SqlError> =>
    Effect.flatMap(
      profiles.getByName(DEFAULT_PROFILE),
      Option.match({
        // The boot seeds it, so this is a database somebody edited.
        onNone: () =>
          Effect.fail(invalidState(`the ${DEFAULT_PROFILE} permission profile is missing`)),
        onSome: (profile) => Effect.succeed(profile.id),
      }),
    );

  /** A thread is filed under a project that exists, or under none at all. */
  const liveProject = (projectId: string): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const live = yield* resources.liveProjects([projectId]);
      if (live.length === 0) {
        return yield* Effect.fail(
          validation([{ path: ["projectId"], message: NO_SUCH_PROJECT_NAMED }]),
        );
      }
    });

  /**
   * The working area and the session in one transaction, then the machine told
   * about the working area, then the dispatch that may start the session: a
   * transaction never spans a wait on a machine, and a machine is never told
   * about a row that may still roll back.
   */
  const place = (open: Placing): Effect.Effect<Session, Validation | SqlError> =>
    Effect.gen(function* () {
      const sessionId = uuidToString(mintUuid());
      const frame = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          const actor = yield* currentStamp;
          // Where it works is the workspaces domain's to decide, in full: what
          // the wish means, how the checkouts are laid out, what the branch is
          // called and which Connection the work acts through.
          const opened = yield* workspaces.openFor({
            wish: open.workspace,
            heldWorkspaceId: open.spec.workspaceId,
            runnerId: open.runnerId,
            projectId: open.projectId,
            sessionId,
            at,
            actor,
          });
          yield* sessions.create({
            id: sessionId,
            permissionProfileId: open.permissionProfileId,
            runnerId: open.runnerId,
            requestedAccessMode: open.requestedAccessMode,
            parentSessionId: open.parentSessionId,
            spec: { ...open.spec, workspaceId: opened.workspaceId },
            prompt: open.prompt,
            kind: open.kind,
            payload: open.payload,
            projectId: open.projectId,
            checkoutBranch: opened.checkoutBranch,
            // The workspace's own account where it has one, and the thread
            // default otherwise: a session pushes as one account, settled here.
            githubConnectionId: opened.designatedConnectionId ?? open.fallbackGithubConnectionId,
            at,
          });
          return opened.frame;
        }),
      );
      // In the order the machine needs them: it makes the working area, and the
      // session it holds is dispatched once it says the area stands.
      if (frame !== undefined) yield* presence.tell(open.runnerId, frame);
      yield* dispatch(open.runnerId);
      // Read back rather than returned from the insert, so the caller sees
      // `starting` where dispatch placed it at once rather than `queued`.
      const after = yield* rows.one(sessionId);
      if (Option.isNone(after)) {
        return yield* Effect.die("a session that was just inserted could not be read back");
      }
      return after.value;
    });

  return {
    /**
     * A thread the user opened: their `thread.*` settings say what it runs
     * under unless this call overrides them, the fleet says where, and the
     * working area it asked for is made before the harness can start in it.
     *
     * Only a Thread can be placed in this build, and only by the user: every
     * value comes from their `thread.*` settings plus this call's overrides, so
     * any other actor reaching those defaults would make the thread profile an
     * escalation path (spec 02 Thread).
     */
    placeSession: (input: SessionSpawnInput): Effect.Effect<Session, PlaceError> =>
      Effect.gen(function* () {
        // A Thread carries the user's own thread profile, so only the user may
        // open one (spec 02 Thread).
        const user = yield* currentUser("session.spawn");
        const decoded = yield* Effect.mapError(decodeSpawn(input), validationOf);
        if (decoded.projectId !== undefined) yield* liveProject(decoded.projectId);
        // Read before placement: a workspace that already stands decides which
        // machine the session runs on, because that is where its files are.
        const pinnedTo =
          decoded.workspace?.kind === "existing"
            ? yield* workspaces.machineFor(decoded.workspace.workspaceId, decoded.runnerId)
            : undefined;
        // An override is for this session only, never written back to the store.
        const defaults = yield* settings.allForUser(user.userId);

        const instanceId =
          decoded.instanceId ?? defaults["thread.instanceId"] ?? (yield* firstLoggedIn());
        const { definition, snapshots } = yield* resolved(instanceId);
        const placeOn = pinnedTo ?? decoded.runnerId;
        const hosting = yield* placeOn === undefined
          ? placement(snapshots)
          : explicitRunner(placeOn, snapshots);

        const requestedAccessMode =
          decoded.accessMode ?? defaults["thread.accessMode"] ?? DEFAULT_ACCESS_MODE;
        const accessMode = nearestSupportedAccessMode(
          requestedAccessMode,
          definition.declared.accessModes,
        );
        if (accessMode === undefined) {
          return yield* Effect.fail(
            invalidState(
              `${definition.displayName} supports no access mode at or below ${requestedAccessMode}`,
            ),
          );
        }

        const model =
          decoded.model ??
          defaults["thread.model"] ??
          (hosting.models.find((one) => one.isDefault) ?? hosting.models[0])?.slug;
        if (model === undefined) {
          return yield* Effect.fail(
            invalidState("that machine reported no models for this provider instance"),
          );
        }

        yield* validatedOptions(hosting.models, model, decoded.options ?? {});

        if (decoded.permissionProfileId !== undefined) {
          yield* requireProfile(decoded.permissionProfileId);
        }
        const profileId =
          decoded.permissionProfileId ?? defaults["thread.profileId"] ?? (yield* threadProfile());

        const spec = {
          instanceId,
          workspaceId: null,
          modelSelection: { model, options: decoded.options ?? {} },
          accessMode,
          timeouts: timeoutsFrom(yield* settings.all()),
        } satisfies SessionSpec;

        return yield* place({
          permissionProfileId: profileId,
          runnerId: hosting.runnerId,
          requestedAccessMode,
          parentSessionId: undefined,
          spec,
          prompt: decoded.prompt,
          kind: "session.spawned",
          projectId: decoded.projectId,
          workspace: decoded.workspace,
          fallbackGithubConnectionId: defaults["thread.githubConnectionId"] ?? undefined,
          payload: {
            instanceId,
            runnerId: hosting.runnerId,
            requestedAccessMode,
            accessMode,
            ...(decoded.projectId === undefined ? {} : { projectId: decoded.projectId }),
          },
        });
      }),

    /**
     * A second session forked off the provider-native one the parent left
     * behind, on the same machine and the same instance, because that is where
     * the native state is (spec 06 section 4.1). Only an exited parent may be
     * forked from. Resuming the parent itself is `session.input`'s.
     *
     * It carries the parent's own profile onto the fork rather than reaching
     * the user's thread defaults, so unlike a spawn a session holding
     * `session.spawn` may make one - but only of a session on the profile it is
     * bounded by itself. Any other parent would be an escalation: `session.read`
     * is unscoped, so a session can find every other session on the controller,
     * and forking one on a wider profile would hand it that profile's grants
     * with a prompt of its own choosing.
     */
    continueSession: (input: ContinueInput): Effect.Effect<Session, ContinueError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("session.continue");
        const { id, mode, prompt } = yield* Effect.mapError(decodeContinue(input), validationOf);
        const parent = yield* one(id);
        if (actor._tag === "session" && parent.permissionProfileId !== actor.profileId) {
          return yield* Effect.fail(forbidden("session.spawn", NOT_ITS_PROFILE));
        }
        // Read for what it refuses: an instance that is gone, or a provider this
        // build no longer carries, before the machine's snapshot is trusted.
        yield* resolved(parent.instanceId);
        const nativeSessionId = yield* resumableNativeSession(parent);

        return yield* place({
          permissionProfileId: parent.permissionProfileId,
          runnerId: parent.runnerId,
          requestedAccessMode: parent.requestedAccessMode,
          parentSessionId: parent.id,
          // A fork carries on in the workspace and the project the parent was
          // in: it is the same piece of work, branched.
          spec: continuingSpecOf(
            parent,
            yield* settings.all(),
            parent.modelSelection,
            nativeSessionId,
            mode,
          ),
          prompt,
          kind: "session.continued",
          projectId: parent.projectId ?? undefined,
          workspace: undefined,
          fallbackGithubConnectionId: parent.githubConnectionId ?? undefined,
          payload: { parentSessionId: parent.id, mode },
        });
      }),
  };
});

export class Placement extends Context.Service<Placement, Effect.Success<typeof make>>()(
  "hydra/controller/daemon/Placement",
) {}

export const PlacementLayer: Layer.Layer<
  Placement,
  never,
  | SqlClient.SqlClient
  | SessionService
  | WorkspaceService
  | RunnerPresence
  | PermissionProfiles
  | Settings
  | PluginHost
  | Dispatch
> = Layer.effect(Placement)(make);
