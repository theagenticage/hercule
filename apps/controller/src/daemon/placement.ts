/**
 * Placing a session: what it runs under, which machine hosts it and where on
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
import { lintOutputSchema, type AccessMode, type SessionSpec } from "@hercule/protocol";
import {
  ACCESS_MODE_CHAIN,
  createForbiddenError,
  Id,
  createInvalidStateError,
  createNotFoundError,
  nearestSupportedAccessMode,
  SESSION_CONTINUE_FIELDS,
  SessionSpawnInput,
  createValidationError,
  createDecodeValidationError,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Session,
  type SpawnWorkspace,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { agentRepository, type StoredAgent } from "../agents";
import { requireGrant, type Actor } from "../actor";
import { mintUuid, nowIso, uuidToString, withTransaction } from "../db";
import { PermissionProfiles, type GrantsError, type PermissionProfile } from "../permissions";
import type { PluginHost } from "../plugins";
import {
  loggedIn,
  NO_PLACEMENT,
  providerRepository,
  resolvedInstance,
  type StoredSnapshot,
} from "../providers";
import { resourceRepository } from "../resources";
import { DRAINING, NO_SUCH_RUNNER, RETIRED, RunnerConnections, runnerRepository } from "../runners";
import {
  buildContinuingSpec,
  requireSession,
  sessionRecordComposer,
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

type ContinueInput = Schema.Schema.Type<typeof ContinueInput>;

const decodeSpawn = Schema.decodeUnknownEffect(SessionSpawnInput);
const decodeContinue = Schema.decodeUnknownEffect(ContinueInput);

const NO_SUCH_PROFILE = "no such permission profile";

const NO_SUCH_AGENT = "no such agent";

/** Why a session may not spawn from an Agent that holds more grants than it does. */
const NOT_ITS_GRANTS =
  "a session may only spawn from an agent whose profile grants no more than its own; " +
  "spawn from an agent on a narrower profile, or let the user spawn this one";

/** Why a session may not open a session on more than the Agent itself runs on. */
const NOT_ITS_ACCESS_MODE =
  "a session may only spawn from an agent at or below the access mode the agent itself names; " +
  "send accessMode at or below the agent's, or leave it out";

/**
 * Refuses the two fields the Agent itself answers. If the call could override
 * them, it would open a session that the Agent never described.
 *
 * Every other per-spawn field is an override the Agent expects (spec 02
 * Agent), so no other field is refused for holding a value. The access mode is
 * an override too. Which mode the caller may ask for is a question about the
 * actor, not about the field, and `mayRunOn` below answers it.
 */
const refuseAgentOwnedFields = (spawn: SessionSpawnInput): Effect.Effect<void, Validation> => {
  for (const field of ["instanceId", "permissionProfileId"] as const) {
    if (spawn[field] !== undefined) {
      return Effect.fail(
        createValidationError([
          { path: [field], message: `${field} comes from the agent this session is spawned from` },
        ]),
      );
    }
  }
  return Effect.void;
};

const NO_SUCH_PROJECT_NAMED = "no such project";

/** Why a Thread is not a session's to open. */
const THREAD_IS_THE_USERS =
  "a Thread is the user's own, and no session may open one; " +
  "send agentId to spawn from an Agent";

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
  /** The Agent the session was spawned from; absent is a Thread. */
  readonly agentId: string | undefined;
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
  const agents = yield* agentRepository;
  const recordComposer = yield* sessionRecordComposer;
  const workspaces = yield* WorkspaceService;
  const resources = yield* resourceRepository;
  const instances = yield* providerRepository;
  const resolved = yield* resolvedInstance;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
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
      if (found === undefined) return yield* Effect.fail(createInvalidStateError(NO_PLACEMENT));
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
        return yield* Effect.fail(
          createValidationError([{ path: ["runnerId"], message: NO_SUCH_RUNNER }]),
        );
      }
      const runner = found.value;
      if (runner.lifecycle !== "active") {
        return yield* Effect.fail(
          createInvalidStateError(runner.lifecycle === "retired" ? RETIRED : DRAINING),
        );
      }
      const snapshot = snapshots.find((one) => one.runnerId === runnerId && loggedIn(one));
      if (snapshot === undefined) return yield* Effect.fail(createInvalidStateError(NO_PLACEMENT));
      return snapshot;
    });

  /**
   * The Agent a spawn names, and the permission profile that Agent gives its
   * sessions.
   *
   * The profile is read, not trusted from the agent row. The session's token
   * carries that profile, and a profile that is gone would mint a token that
   * resolves to no actor.
   */
  const requireAgentWithProfile = (
    agentId: string,
  ): Effect.Effect<
    { readonly agent: StoredAgent; readonly profile: PermissionProfile },
    NotFound | InvalidState | GrantsError | SqlError
  > =>
    Effect.gen(function* () {
      const row = yield* agents.read(agentId);
      if (Option.isNone(row)) return yield* Effect.fail(createNotFoundError(NO_SUCH_AGENT));
      const agent = row.value;
      const profile = yield* profiles.getById(agent.permissionProfileId);
      if (Option.isNone(profile)) {
        return yield* Effect.fail(
          createInvalidStateError(
            `the agent's permission profile ${agent.permissionProfileId} no longer exists; ` +
              "point the agent at another profile, then spawn again",
          ),
        );
      }
      return { agent, profile: profile.value };
    });

  /**
   * Whether this actor may spawn from an Agent that this profile bounds.
   *
   * A session may spawn from an Agent only if the Agent's profile grants no
   * more than the session holds. The rule exists so that an assistant can hand
   * work to a worker with fewer grants. Without the rule, a session could spawn
   * from an Agent with more grants and give it a prompt of its own, which would
   * raise the session's own reach. The user holds every grant and so passes
   * every profile.
   *
   * The switch is closed on purpose. A kind of actor that has no rule here is
   * refused, so the run actor and the plugin actor to come must arrive with a
   * rule of their own.
   */
  const mayRunAs = (actor: Actor, profile: PermissionProfile): boolean => {
    switch (actor._tag) {
      case "user":
        return true;
      case "session":
        return profile.grants.every((grant) => actor.grants.includes(grant));
      default:
        return false;
    }
  };

  /**
   * Whether this actor may open the session on the access mode the call named.
   * A per-spawn `accessMode` is an override the Agent expects (spec 02 Agent).
   * The user may name any mode. A session may only move the mode down the
   * chain. If a session could move the mode up, a spawner could hand a worker
   * more of the machine than the Agent was ever configured for. That is the
   * escalation the grant rule above closes, on the other axis (spec 13
   * section 6.3).
   *
   * The order is the order `nearestSupportedAccessMode` uses, so "more
   * permissive" means the same here as where a provider falls back.
   */
  const mayRunOn = (actor: Actor, requested: AccessMode | undefined, agent: StoredAgent): boolean =>
    actor._tag !== "session" ||
    requested === undefined ||
    ACCESS_MODE_CHAIN.indexOf(requested) <= ACCESS_MODE_CHAIN.indexOf(agent.accessMode);

  /**
   * Checks the output schema against the subset every harness can be held to.
   * The check runs before anything is written, so a schema outside the subset
   * leaves no session behind, and the caller is told which rule it broke.
   */
  const requireLintedSchema = (
    schema: SessionSpec["outputSchema"],
  ): Effect.Effect<SessionSpec["outputSchema"], Validation> => {
    if (schema === undefined) return Effect.succeed(undefined);
    const issues = lintOutputSchema(schema);
    return issues.length === 0
      ? Effect.succeed(schema)
      : Effect.fail(
          createValidationError(
            issues.map((issue) => ({ path: ["outputSchema"], message: issue })),
          ),
        );
  };

  /** Refuses a permissionProfileId naming no profile, before it is trusted as this session's. */
  const requireProfile = (
    profileId: string,
  ): Effect.Effect<void, Validation | GrantsError | SqlError> =>
    Effect.gen(function* () {
      const found = yield* profiles.getById(profileId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          createValidationError([{ path: ["permissionProfileId"], message: NO_SUCH_PROFILE }]),
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
        createInvalidStateError(
          "no provider instance has a logged-in machine; log in on one first",
        ),
      );
    });

  const threadProfile = (): Effect.Effect<string, InvalidState | GrantsError | SqlError> =>
    Effect.flatMap(
      profiles.getByName(DEFAULT_PROFILE),
      Option.match({
        // The boot seeds it, so this is a database somebody edited.
        onNone: () =>
          Effect.fail(
            createInvalidStateError(`the ${DEFAULT_PROFILE} permission profile is missing`),
          ),
        onSome: (profile) => Effect.succeed(profile.id),
      }),
    );

  /** A thread is filed under a project that exists, or under none at all. */
  const liveProject = (projectId: string): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const live = yield* resources.liveProjects([projectId]);
      if (live.length === 0) {
        return yield* Effect.fail(
          createValidationError([{ path: ["projectId"], message: NO_SUCH_PROJECT_NAMED }]),
        );
      }
    });

  /**
   * The working area and the session in one transaction, then the machine told
   * about the working area, then the dispatch that may start the session: a
   * transaction never spans a wait on a machine, and a machine is never told
   * about a row that may still roll back.
   */
  const place = (open: Placing): Effect.Effect<Session, Validation | NotFound | SqlError> =>
    Effect.gen(function* () {
      const sessionId = uuidToString(mintUuid());
      const frame = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          // The Agent is read again, this time inside the write set. It was
          // first read before placement. An agent delete is refused while a
          // session it spawned runs, and that refusal must not be defeated by
          // a spawn that is still being placed.
          if (open.agentId !== undefined && Option.isNone(yield* agents.read(open.agentId))) {
            return yield* Effect.fail(createNotFoundError(NO_SUCH_AGENT));
          }
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
          });
          yield* sessions.create({
            id: sessionId,
            permissionProfileId: open.permissionProfileId,
            agentId: open.agentId,
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
      if (frame !== undefined) yield* connections.tell(open.runnerId, frame);
      yield* dispatch(open.runnerId);
      // Read back rather than returned from the insert, so the caller sees
      // `starting` where dispatch placed it at once rather than `queued`.
      const after = yield* rows.one(sessionId);
      if (Option.isNone(after)) {
        return yield* Effect.die("a session that was just inserted could not be read back");
      }
      return (yield* recordComposer)(after.value);
    });

  return {
    /**
     * Opens one session: an Agent's session, or a Thread where the call names
     * no Agent. Either way each field is resolved once, along one precedence
     * chain: the value this call names, then the Agent's value or the user's
     * `thread.*` setting, then what the instance offers. One chain, because a
     * second chain would be a second answer to "what does this session run
     * under". The model and its options walk the chain together, as the one
     * selection they are.
     *
     * A Thread is the user's alone. Every value a Thread takes comes from the
     * user's own settings, so another actor that reached those settings would
     * make the thread profile an escalation path (spec 02 Thread). An Agent
     * names a profile of its own, so any actor may spawn from an Agent, up to
     * the grants that actor holds itself, and at or below the access mode the
     * Agent names. The user's overrides are unrestricted (spec 13 section 6.3).
     *
     * The fleet decides which machine hosts the session, and the working area
     * the session asked for is made before the harness starts in it.
     */
    placeSession: (input: SessionSpawnInput): Effect.Effect<Session, PlaceError | NotFound> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("session.spawn");
        const decoded = yield* Effect.mapError(decodeSpawn(input), createDecodeValidationError);
        if (decoded.agentId !== undefined) yield* refuseAgentOwnedFields(decoded);
        const spawnedFrom =
          decoded.agentId === undefined
            ? undefined
            : yield* requireAgentWithProfile(decoded.agentId);
        const agent = spawnedFrom?.agent;
        // Only a Thread reads the user's own settings, so only the user may
        // open a Thread. A spawn from an Agent takes its values from the Agent
        // instead, so any actor may make one if it holds the grant and is
        // bounded by at least as much as the Agent is.
        const user = actor._tag === "user" ? actor : undefined;
        if (spawnedFrom === undefined && user === undefined) {
          return yield* Effect.fail(createForbiddenError("session.spawn", THREAD_IS_THE_USERS));
        }
        if (spawnedFrom !== undefined) {
          if (!mayRunAs(actor, spawnedFrom.profile)) {
            return yield* Effect.fail(createForbiddenError("session.spawn", NOT_ITS_GRANTS));
          }
          if (!mayRunOn(actor, decoded.accessMode, spawnedFrom.agent)) {
            return yield* Effect.fail(createForbiddenError("session.spawn", NOT_ITS_ACCESS_MODE));
          }
        }
        const outputSchema = yield* requireLintedSchema(decoded.outputSchema);
        if (decoded.projectId !== undefined) yield* liveProject(decoded.projectId);
        // Read before placement: a workspace that already stands decides which
        // machine the session runs on, because that is where its files are.
        const pinnedTo =
          decoded.workspace?.kind === "existing"
            ? yield* workspaces.machineFor(decoded.workspace.workspaceId, decoded.runnerId)
            : undefined;
        // An override applies to this session only. Nothing is written back to
        // the settings. A spawn from an Agent reads no thread setting, not even
        // for the user: the Agent answers every default a setting would have
        // answered.
        const defaults =
          user === undefined || agent !== undefined ? {} : yield* settings.allForUser(user.userId);

        const instanceId =
          decoded.instanceId ??
          agent?.instanceId ??
          defaults["thread.instanceId"] ??
          (yield* firstLoggedIn());
        const { definition, snapshots } = yield* resolved(instanceId);
        const placeOn = pinnedTo ?? decoded.runnerId;
        const hosting = yield* placeOn === undefined
          ? placement(snapshots)
          : explicitRunner(placeOn, snapshots);

        const requestedAccessMode =
          decoded.accessMode ??
          agent?.accessMode ??
          defaults["thread.accessMode"] ??
          DEFAULT_ACCESS_MODE;
        const accessMode = nearestSupportedAccessMode(
          requestedAccessMode,
          definition.declared.accessModes,
        );
        if (accessMode === undefined) {
          return yield* Effect.fail(
            createInvalidStateError(
              `${definition.displayName} supports no access mode at or below ${requestedAccessMode}`,
            ),
          );
        }

        // A model and its options are one selection, not two fields a call may
        // take one half of. A choice belongs to the model that offered it.
        // Therefore the Agent's selection stands only while the Agent's model
        // stands. A call that names a model of its own opens on the choices it
        // named beside that model, or on no choices at all.
        const agentSelection = decoded.model === undefined ? agent?.model : undefined;
        const model =
          decoded.model ??
          agentSelection?.model ??
          defaults["thread.model"] ??
          (hosting.models.find((one) => one.isDefault) ?? hosting.models[0])?.slug;
        if (model === undefined) {
          return yield* Effect.fail(
            createInvalidStateError("that machine reported no models for this provider instance"),
          );
        }
        // The choices are held to the model they run on, whatever they came
        // from. A choice the model does not offer is refused by name. It is
        // not dropped because it came from the Agent.
        const options = decoded.options ?? agentSelection?.options ?? {};
        yield* validatedOptions(hosting.models, model, options);

        if (decoded.permissionProfileId !== undefined) {
          yield* requireProfile(decoded.permissionProfileId);
        }
        const profileId =
          decoded.permissionProfileId ??
          agent?.permissionProfileId ??
          defaults["thread.profileId"] ??
          (yield* threadProfile());

        const spec = {
          instanceId,
          workspaceId: null,
          modelSelection: { model, options },
          accessMode,
          ...(agent === undefined ? {} : { systemPrompt: agent.systemPrompt }),
          ...(agent === undefined || agent.disallowedTools.length === 0
            ? {}
            : { disallowedTools: agent.disallowedTools }),
          ...(outputSchema === undefined ? {} : { outputSchema }),
          timeouts: timeoutsFrom(yield* settings.all()),
        } satisfies SessionSpec;

        return yield* place({
          permissionProfileId: profileId,
          agentId: agent?.id,
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
            ...(agent === undefined ? {} : { agentId: agent.id }),
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
        const { id, mode, prompt } = yield* Effect.mapError(
          decodeContinue(input),
          createDecodeValidationError,
        );
        const parent = yield* one(id);
        if (actor._tag === "session" && parent.permissionProfileId !== actor.profileId) {
          return yield* Effect.fail(createForbiddenError("session.spawn", NOT_ITS_PROFILE));
        }
        // Read for what it refuses: an instance that is gone, or a provider this
        // build no longer carries, before the machine's snapshot is trusted.
        yield* resolved(parent.instanceId);
        const nativeSessionId = yield* resumableNativeSession(parent);

        return yield* place({
          permissionProfileId: parent.permissionProfileId,
          // The fork is the same piece of work under the same configuration,
          // so it carries the same lineage as its parent.
          agentId: parent.agentId ?? undefined,
          runnerId: parent.runnerId,
          requestedAccessMode: parent.requestedAccessMode,
          parentSessionId: parent.id,
          // A fork carries on under the document the parent's machine was
          // told, in the workspace and the project the parent was in. It is
          // the same piece of work, branched.
          spec: buildContinuingSpec(
            yield* sessions.readSpec(parent.id),
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
  "hercule/controller/daemon/Placement",
) {}

export const PlacementLayer: Layer.Layer<
  Placement,
  never,
  | SqlClient.SqlClient
  | SessionService
  | WorkspaceService
  | RunnerConnections
  | PermissionProfiles
  | Settings
  | PluginHost
  | Dispatch
> = Layer.effect(Placement)(make);
