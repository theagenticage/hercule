/**
 * Placing a session: deciding what it runs under, which runner hosts it, and
 * which workspace it works in.
 *
 * All of that is decided before any row exists. Then the session, its first
 * input, its audit entry and its workspace are written in one transaction.
 * The runner is told about the workspace only after that commit.
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
  findNearestSupportedAccessMode,
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
import { agentRepository, type StoredAgent } from "../../agents";
import { requireGrant, type Actor } from "../../actor";
import { mintUuid, nowIso, uuidToString, withTransaction } from "../../db";
import { PermissionProfiles, type GrantsError, type PermissionProfile } from "../../permissions";
import type { PluginHost } from "../../plugins";
import {
  isLoggedIn,
  NO_PLACEMENT,
  providerRepository,
  resolvedInstance,
  type StoredSnapshot,
} from "../../providers";
import { resourceRepository } from "../../resources";
import {
  DRAINING,
  NO_SUCH_RUNNER,
  RETIRED,
  RunnerConnections,
  runnerRepository,
} from "../../runners";
import {
  buildContinuingSpec,
  readSessionOrFail,
  sessionRecordComposer,
  SessionService,
  sessionRepository,
  buildTimeouts,
  validateOptions,
} from "../../sessions";
import { Settings, type SettingError } from "../../settings";
import { WorkspaceService } from "../../workspaces";
import { Dispatch } from "./dispatch";
import { resumable } from "./resuming";

const ContinueInput = Schema.Struct({ id: Id, ...SESSION_CONTINUE_FIELDS });

type ContinueInput = Schema.Schema.Type<typeof ContinueInput>;

const decodeSpawn = Schema.decodeUnknownEffect(SessionSpawnInput);
const decodeContinue = Schema.decodeUnknownEffect(ContinueInput);

const NO_SUCH_PROFILE = "no such permission profile";

const NO_SUCH_AGENT = "no such agent";

/**
 * The error message for a spawn from an assistant. An assistant's sessions
 * are started by its conversation, never by a spawn.
 */
const ASSISTANT_SPAWN_REFUSED =
  "an assistant's sessions belong to its conversation; send it a message with conversation.send";

/** The error message when a session spawns from an Agent with more grants than the session has. */
const NOT_ITS_GRANTS =
  "a session may only spawn from an agent whose profile grants no more than its own; " +
  "spawn from an agent on a narrower profile, or let the user spawn this one";

/** The error message when a session asks for a more permissive access mode than the Agent's. */
const NOT_ITS_ACCESS_MODE =
  "a session may only spawn from an agent at or below the access mode the agent itself names; " +
  "send accessMode at or below the agent's, or leave it out";

/**
 * Fails with a validation error when a spawn from an Agent sets `instanceId`
 * or `permissionProfileId`. Those two fields always come from the Agent: if a
 * call could override them, it would open a session the Agent never
 * described.
 *
 * Every other per-spawn field is an override the Agent allows (spec 02 Agent),
 * so no other field is rejected for having a value. The access mode is an
 * override too. Which modes a caller may ask for depends on the actor, not on
 * the field, and `mayRunOn` below checks that.
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

/** The error message when a session tries to open a Thread. */
const THREAD_IS_THE_USERS =
  "a Thread is the user's own, and no session may open one; " +
  "send agentId to spawn from an Agent";

/** The error message when a session continues a session on a different permission profile. */
const NOT_ITS_PROFILE = "a session may only continue a session on its own permission profile";

/** The shipped profile a thread takes when the user has chosen none (spec 02 Thread). */
const DEFAULT_PROFILE = "unrestricted";

const DEFAULT_ACCESS_MODE: AccessMode = "approval-required";

/** The errors both a spawn and a continue can fail with. */
type Refusal =
  | Unauthenticated
  | Forbidden
  | Validation
  | SqlError
  | InvalidState
  | SettingError
  | Schema.SchemaError;

/** The errors of a spawn, which also reads permission profiles. A fork takes its parent's profile. */
type PlaceError = Refusal | GrantsError;

/** The errors of a continue, which also fails when the parent session does not exist. */
type ContinueError = Refusal | NotFound;

/**
 * Everything needed to open one session on a runner, for both a spawn and a
 * continue.
 */
interface Placing {
  readonly permissionProfileId: string;
  /** The Agent the session was spawned from, or undefined for a Thread. */
  readonly agentId: string | undefined;
  readonly runnerId: string;
  readonly requestedAccessMode: AccessMode;
  readonly parentSessionId: string | undefined;
  /** The spec the runner receives. Its workspace id is filled in while placing. */
  readonly spec: SessionSpec;
  readonly prompt: string;
  readonly kind: "session.spawned" | "session.continued";
  /** The audit entry's payload, beyond the new session's id. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projectId: string | undefined;
  /** The workspace the session asked for. When undefined, the spec's workspace is kept. */
  readonly workspace: SpawnWorkspace | undefined;
  /** The GitHub connection the session pushes as when its workspace names none. */
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
  const one = readSessionOrFail(rows);
  const resumableNativeSession = yield* resumable;
  const { dispatch } = yield* Dispatch;

  /**
   * Chooses the runner for a session when the caller did not name one: the
   * first placeable runner whose capability snapshot shows this instance is
   * logged in. Fails with an invalid state error when there is none.
   */
  const choosePlacement = (
    snapshots: ReadonlyArray<StoredSnapshot>,
  ): Effect.Effect<StoredSnapshot, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const placeable = yield* runners.placeable();
      const found = snapshots.find(
        (snapshot) => isLoggedIn(snapshot) && placeable.has(snapshot.runnerId),
      );
      if (found === undefined) return yield* Effect.fail(createInvalidStateError(NO_PLACEMENT));
      return found;
    });

  /**
   * Returns the snapshot of the runner the caller named. Fails when the runner
   * does not exist, is draining or retired, or has no logged-in snapshot for
   * this instance.
   *
   * A named runner is used even when it is reserved, full, or not connected
   * right now. It is checked on its own, the way `continue` checks the runner
   * it is pinned to, and not filtered through `placeable`, which is only for
   * the automatic choice above. Whether the runner can start the session now
   * is for dispatch to decide; until then, the session waits in its queue.
   */
  const chooseExplicitRunner = (
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
      const snapshot = snapshots.find((one) => one.runnerId === runnerId && isLoggedIn(one));
      if (snapshot === undefined) return yield* Effect.fail(createInvalidStateError(NO_PLACEMENT));
      return snapshot;
    });

  /**
   * Reads the Agent a spawn names, and the permission profile it gives its
   * sessions. Fails with not found when the Agent does not exist, and with an
   * invalid state error when it is an assistant or its profile no longer
   * exists.
   *
   * The profile is read, not trusted from the agent row. The session's token
   * carries that profile, and a deleted profile would give a token that
   * resolves to no actor.
   */
  const readAgentWithProfileOrFail = (
    agentId: string,
  ): Effect.Effect<
    { readonly agent: StoredAgent; readonly profile: PermissionProfile },
    NotFound | InvalidState | GrantsError | SqlError
  > =>
    Effect.gen(function* () {
      const row = yield* agents.read(agentId);
      if (Option.isNone(row)) return yield* Effect.fail(createNotFoundError(NO_SUCH_AGENT));
      const agent = row.value;
      if (agent.kind === "assistant") {
        return yield* Effect.fail(createInvalidStateError(ASSISTANT_SPAWN_REFUSED));
      }
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
   * Checks whether this actor may spawn from an Agent with this profile.
   *
   * A session may spawn from an Agent only if the Agent's profile grants no
   * more than the session has. The rule lets an assistant hand work to a
   * worker with fewer grants. Without it, a session could spawn from an Agent
   * with more grants and give it any prompt, which would widen what the
   * session can do. The user has every grant, so the check passes for every profile.
   *
   * Any other kind of actor is rejected on purpose, so the future run and
   * plugin actors must come with a rule of their own.
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
   * Checks whether this actor may open the session with the access mode the
   * call asked for. A per-spawn `accessMode` is an override the Agent allows
   * (spec 02 Agent).
   *
   * - The user may ask for any mode.
   * - A session may ask only for the Agent's mode or a less permissive one.
   *   Otherwise a session could give a worker more access to the machine than
   *   the Agent was configured for. This is the same escalation the grant
   *   rule above prevents, on the other axis (spec 13 section 6.3).
   *
   * The order is the one `findNearestSupportedAccessMode` uses, so "more
   * permissive" means the same here as in the provider fallback.
   */
  const mayRunOn = (actor: Actor, requested: AccessMode | undefined, agent: StoredAgent): boolean =>
    actor._tag !== "session" ||
    requested === undefined ||
    ACCESS_MODE_CHAIN.indexOf(requested) <= ACCESS_MODE_CHAIN.indexOf(agent.accessMode);

  /**
   * Checks the output schema against the subset every harness supports.
   * Returns the schema, or fails with a validation error for each rule it
   * breaks. The check runs before anything is written, so an invalid schema
   * leaves no session behind.
   */
  const validateOutputSchema = (
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

  /** Fails with a validation error when `permissionProfileId` names no existing profile. */
  const validateProfileExists = (
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

  /**
   * Returns the first provider instance that is logged in on some runner. A
   * Thread uses it when the user has not set `thread.instanceId` (spec 02
   * Thread). Fails with an invalid state error when no instance is logged in.
   */
  const pickLoggedInInstance = (): Effect.Effect<
    string,
    InvalidState | SqlError | Schema.SchemaError
  > =>
    Effect.gen(function* () {
      for (const snapshot of yield* instances.snapshots()) {
        if (isLoggedIn(snapshot)) return snapshot.instanceId;
      }
      return yield* Effect.fail(
        createInvalidStateError(
          "no provider instance is logged in on any runner; log in on a runner first",
        ),
      );
    });

  const readThreadProfileId = (): Effect.Effect<string, InvalidState | GrantsError | SqlError> =>
    Effect.flatMap(
      profiles.getByName(DEFAULT_PROFILE),
      Option.match({
        // Boot creates this profile, so it is missing only if someone edited
        // the database.
        onNone: () =>
          Effect.fail(
            createInvalidStateError(`the ${DEFAULT_PROFILE} permission profile is missing`),
          ),
        onSome: (profile) => Effect.succeed(profile.id),
      }),
    );

  /** Fails with a validation error when `projectId` names no live project. */
  const validateLiveProject = (projectId: string): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const live = yield* resources.liveProjects([projectId]);
      if (live.length === 0) {
        return yield* Effect.fail(
          createValidationError([{ path: ["projectId"], message: NO_SUCH_PROJECT_NAMED }]),
        );
      }
    });

  /**
   * Writes the workspace and the session in one transaction, then tells the
   * runner about the workspace, then dispatches, which may start the session.
   * Returns the new session. A transaction never waits on a runner, and a
   * runner is never told about a row that could still roll back.
   */
  const place = (open: Placing): Effect.Effect<Session, Validation | NotFound | SqlError> =>
    Effect.gen(function* () {
      const sessionId = uuidToString(mintUuid());
      const frame = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          // Read the Agent again, this time inside the transaction. Deleting
          // an agent is rejected while a session spawned from it runs, and a
          // spawn that is still being placed must not get around that check.
          if (open.agentId !== undefined && Option.isNone(yield* agents.read(open.agentId))) {
            return yield* Effect.fail(createNotFoundError(NO_SUCH_AGENT));
          }
          // The workspaces domain decides everything about where the session
          // works: what the request means, how the checkouts are laid out,
          // what the branch is called and which Connection the work uses.
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
            // The workspace's own connection if it has one, otherwise the
            // thread default. A session pushes as one account, chosen here.
            githubConnectionId: opened.designatedConnectionId ?? open.fallbackGithubConnectionId,
            at,
          });
          return opened.frame;
        }),
      );
      // In the order the runner needs them: it provisions the workspace, and
      // the session is dispatched once the runner reports the workspace ready.
      if (frame !== undefined) yield* connections.tell(open.runnerId, frame);
      yield* dispatch(open.runnerId);
      // Read back instead of using the inserted row, so the caller sees
      // `starting` when dispatch started the session at once, not `queued`.
      const after = yield* rows.one(sessionId);
      if (Option.isNone(after)) {
        return yield* Effect.die("a session that was just inserted could not be read back");
      }
      return (yield* recordComposer)(after.value);
    });

  return {
    /**
     * Spawns one session: from an Agent, or a Thread when the call names no
     * Agent. Returns the new session.
     *
     * Each field is resolved once, in this order of precedence:
     *
     * 1. the value in this call;
     * 2. the Agent's value, or for a Thread the user's `thread.*` setting;
     * 3. the instance's default.
     *
     * There is one order only, so there is one answer to "what does this
     * session run under". The model and its options are resolved together, as
     * one selection.
     *
     * Only the user may open a Thread. A Thread takes its values from the
     * user's own settings, so letting another actor use them would make the
     * thread profile a way to escalate (spec 02 Thread). An Agent has a
     * profile of its own, so any actor may spawn from an Agent, up to the
     * grants that actor has, and at or below the Agent's access mode. The
     * user's overrides are unrestricted (spec 13 section 6.3).
     *
     * Placement chooses the runner unless the call names one, and the
     * requested workspace is provisioned before the harness starts in it.
     */
    placeSession: (input: SessionSpawnInput): Effect.Effect<Session, PlaceError | NotFound> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("session.spawn");
        const decoded = yield* Effect.mapError(decodeSpawn(input), createDecodeValidationError);
        if (decoded.agentId !== undefined) yield* refuseAgentOwnedFields(decoded);
        const spawnedFrom =
          decoded.agentId === undefined
            ? undefined
            : yield* readAgentWithProfileOrFail(decoded.agentId);
        const agent = spawnedFrom?.agent;
        // Only a Thread reads the user's own settings, so only the user may
        // open a Thread. A spawn from an Agent takes its values from the Agent,
        // so any actor with the grant may make one, as long as it has at least
        // the Agent's grants and asks for no more than the Agent's access mode.
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
        const outputSchema = yield* validateOutputSchema(decoded.outputSchema);
        if (decoded.projectId !== undefined) yield* validateLiveProject(decoded.projectId);
        // Read before placement: an existing workspace decides which runner the
        // session runs on, because that is where its files are.
        const pinnedTo =
          decoded.workspace?.kind === "existing"
            ? yield* workspaces.machineFor(decoded.workspace.workspaceId, decoded.runnerId)
            : undefined;
        // An override applies to this session only and is not written back to
        // the settings. A spawn from an Agent reads no thread setting, even for
        // the user: the Agent provides every default a setting would.
        const defaults =
          user === undefined || agent !== undefined ? {} : yield* settings.allForUser(user.userId);

        const instanceId =
          decoded.instanceId ??
          agent?.instanceId ??
          defaults["thread.instanceId"] ??
          (yield* pickLoggedInInstance());
        const { definition, snapshots } = yield* resolved(instanceId);
        const placeOn = pinnedTo ?? decoded.runnerId;
        const hosting = yield* placeOn === undefined
          ? choosePlacement(snapshots)
          : chooseExplicitRunner(placeOn, snapshots);

        const requestedAccessMode =
          decoded.accessMode ??
          agent?.accessMode ??
          defaults["thread.accessMode"] ??
          DEFAULT_ACCESS_MODE;
        const accessMode = findNearestSupportedAccessMode(
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

        // A model and its options are one selection: options belong to the
        // model that offers them. So the Agent's options apply only when the
        // Agent's model is used. A call that names its own model uses the
        // options it sent with that model, or none at all.
        const agentSelection = decoded.model === undefined ? agent?.model : undefined;
        const model =
          decoded.model ??
          agentSelection?.model ??
          defaults["thread.model"] ??
          (hosting.models.find((one) => one.isDefault) ?? hosting.models[0])?.slug;
        if (model === undefined) {
          return yield* Effect.fail(
            createInvalidStateError("that runner reported no models for this provider instance"),
          );
        }
        // Options are validated against the model, wherever they came from. An
        // option the model does not offer is rejected by name, even when it
        // came from the Agent, rather than silently dropped.
        const options = decoded.options ?? agentSelection?.options ?? {};
        yield* validateOptions(hosting.models, model, options);

        if (decoded.permissionProfileId !== undefined) {
          yield* validateProfileExists(decoded.permissionProfileId);
        }
        const profileId =
          decoded.permissionProfileId ??
          agent?.permissionProfileId ??
          defaults["thread.profileId"] ??
          (yield* readThreadProfileId());

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
          timeouts: buildTimeouts(yield* settings.all()),
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
          fallbackGithubConnectionId: defaults["github.defaultConnectionId"] ?? undefined,
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
     * Opens a new session that continues from the provider-native session an
     * exited parent left behind. Returns the new session. It runs on the same
     * runner and instance as the parent, because that is where the native
     * state is (spec 06 section 4.1). Resuming the parent itself is done by
     * `session.input`.
     *
     * The fork takes the parent's profile rather than the user's thread
     * defaults. So, unlike a Thread, a session may create one, but only from a
     * parent on its own profile. Any other parent would be an escalation:
     * `session.read` is unscoped, so a session can find every other session,
     * and forking one on a wider profile would give it that profile's grants
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
        // Called only for its failures: it fails when the instance is gone, or
        // its provider is no longer registered.
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
          // A fork continues under the parent's spec, in the parent's
          // workspace and project. It is the same piece of work, branched.
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
