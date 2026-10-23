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
import {
  lintOutputSchema,
  OutputSchema,
  type AccessMode,
  type ModelSelection,
  type SessionSpec,
  type WorkspaceProvision,
  type WorkspaceStepKey,
} from "@hercule/protocol";
import {
  ACCESS_MODE_CHAIN,
  createForbiddenError,
  Id,
  createInvalidStateError,
  createNotFoundError,
  findNearestSupportedAccessMode,
  MEMORY_CORE,
  refuseEmptyPrompt,
  SESSION_CONTINUE_FIELDS,
  SessionSpawnInput,
  createValidationError,
  createDecodeValidationError,
  InvalidState,
  type Forbidden,
  type NotFound,
  type Session,
  type SpawnWorkspace,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { agentRepository, type StoredAgent } from "../../agents";
import {
  CurrentActor,
  requireGrant,
  type Actor,
  type SessionActor,
  type UserActor,
} from "../../actor";
import { mintUuid, nowIso, uuidToString, withTransaction } from "../../db";
import { memoryRepository, renderSessionMemory } from "../../memory";
import { PermissionProfiles, type GrantsError, type PermissionProfile } from "../../permissions";
import { deriveCatalogJsonSchema, type PluginHost } from "../../plugins";
import {
  isLoggedIn,
  NO_PLACEMENT,
  providerRepository,
  resolvedInstance,
  type StoredSnapshot,
} from "../../providers";
import { PromotionState } from "../../promotion";
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
  buildConversationTimeouts,
  buildStepSessionTimeouts,
  readSessionOrFail,
  sessionRecordComposer,
  SessionService,
  sessionRepository,
  buildTimeouts,
  type StoredSession,
  validateOptions,
} from "../../sessions";
import { Settings, type SettingError } from "../../settings";
import { buildThreadBranch, WorkspaceService } from "../../workspaces";
import { TextGeneration } from "../../text-generation";
import { makeForkAfterCommit } from "./after-commit";
import { Dispatch } from "./dispatch";
import { resumable } from "./resuming";

const ContinueInput = Schema.Struct({ id: Id, ...SESSION_CONTINUE_FIELDS }).check(
  refuseEmptyPrompt,
);

type ContinueInput = Schema.Schema.Type<typeof ContinueInput>;

const decodeSpawn = Schema.decodeUnknownEffect(SessionSpawnInput);
const decodeContinue = Schema.decodeUnknownEffect(ContinueInput);

/**
 * How many characters of a Thread's first message go to the model that writes
 * its title. A title needs the gist, not the whole message, and a pasted log
 * would only make the call slower and dearer.
 */
const MAX_TITLE_INPUT_LENGTH = 4000;

/** What the model is told when it writes a Thread's title and role. */
const THREAD_TITLE_INSTRUCTIONS =
  "The input is the first message a user sent to a coding assistant. " +
  "Write a short title for the conversation it starts.\n" +
  "- Use at most 6 words.\n" +
  "- Write the title in the language of the message.\n" +
  "- Name the task or the topic. Do not address the assistant, and do not use quotes or a final period.\n" +
  "- Set needsRefinement to true when the message is too vague or too short to title well, " +
  'such as a greeting or "help me". Still write your best title.\n' +
  "- Set role to the job of the conversation in a word or two, " +
  'such as "migration", "fix", "feature", "review", "tests" or "API docs".\n' +
  "- Write the role in lowercase, unless it is a name, and in the language of the message. " +
  "Do not use quotes or a final period.\n" +
  "- Leave role empty when the message is too vague to name a job.";

/**
 * The answer the model gives for a Thread's title and role.
 *
 * `role` has no length limit here, like `title`. A `maxLength` may be outside
 * the strict JSON Schema subset every provider shares, and an answer that
 * misses the schema fails the whole call as `invalid-output`, which would lose
 * a good title over a long role. The service drops a role that is too long.
 */
const ThreadTitleAndRole = Schema.Struct({
  title: Schema.String,
  needsRefinement: Schema.Boolean,
  role: Schema.String,
});

/**
 * `ThreadTitleAndRole` as the JSON Schema a text generation sends to the
 * harness. It is derived once, when this module loads: it never changes, so a
 * schema that did not fit a request frame would fail every test that loads it.
 */
const THREAD_TITLE_AND_ROLE_OUTPUT_SCHEMA = Schema.decodeUnknownSync(OutputSchema)(
  deriveCatalogJsonSchema(ThreadTitleAndRole),
);

const decodeThreadTitleAndRole = Schema.decodeUnknownEffect(ThreadTitleAndRole);

const NO_SUCH_PROFILE = "no such permission profile";

const NO_SUCH_AGENT = "no such agent";

/**
 * The refusal of `session.continue` on a session that answers an assistant's
 * conversation. A fork would be a second session answering the same
 * conversation, outside its messages.
 */
const CONVERSATION_FORK_REFUSED =
  "forking a conversation's session is not supported; " +
  "to branch off, spawn a Thread with `session.spawn` and give it the context it needs";

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
 * Every other per-spawn field may override the Agent's value, so no other
 * field is rejected for having a value. The access mode is an
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

/** The error message when a session without the `thread.start` grant starts a Thread. */
const START_THREAD_NEEDS_GRANT =
  "only the user, or a session that holds the thread.start grant, may start a Thread, " +
  "because a Thread may run at any access mode and, on the local runner, sees the user's own material; " +
  "ask for thread.start with a Permission Request, or send agentId to spawn from an Agent";

/** The error message when a session without the `thread.start` grant forks a Thread. */
const FORK_THREAD_NEEDS_GRANT =
  "only the user, or a session that holds the thread.start grant, may fork a Thread, " +
  "because the fork is a new Thread; " +
  "ask for thread.start with a Permission Request, or spawn from an Agent with agentId instead";

/**
 * The error message when a run or a plugin starts or forks a Thread. Unlike a
 * session, it has no permission profile, so there is nothing the user could
 * give `thread.start` on.
 */
const THREAD_NEEDS_A_PROFILE =
  "only the user, or a session that holds the thread.start grant, may start or fork a Thread, " +
  "and a run or a plugin has no permission profile to hold that grant; " +
  "send agentId to spawn from an Agent instead";

/** The error message when a session starts a Thread on a profile wider than its own. */
const THREAD_PROFILE_NOT_ITS_GRANTS =
  "a session may only start a Thread on a permission profile that grants no more than its own " +
  "(grants a Permission Request gave only this session do not count), " +
  "because a Thread on a wider profile would hand the session grants it does not have; " +
  "name a profile no wider than the session's own, or leave permissionProfileId out to use the session's own";

/** The error message when a session continues a session on a different permission profile. */
const NOT_ITS_PROFILE = "a session may only continue a session on its own permission profile";

/**
 * Added to a placement refusal when the spawn followed its calling session to
 * that session's runner, because the call itself named no runner and the
 * refusal would otherwise blame a runner the caller never chose.
 */
const FOLLOWED_CALLER =
  "the spawn runs on the calling session's runner because the call named none; " +
  "send runnerId to run it on another runner";

/**
 * Returns the workspace a session's spawn works in. The call's own workspace
 * wins. When the call names none, the spawn joins the calling session's
 * workspace if it runs on the caller's runner and the caller has a workspace,
 * because a session usually spawns another to work on the same files, such as
 * a reviewer. A spawn on another runner cannot reach those files, so it gets
 * no workspace unless the call asks for one.
 */
const chooseWorkspaceNextToCaller = (
  caller: StoredSession,
  call: SessionSpawnInput,
): SpawnWorkspace | undefined => {
  if (call.workspace !== undefined) return call.workspace;
  const onCallersRunner = call.runnerId === undefined || call.runnerId === caller.runnerId;
  if (caller.workspaceId === null || !onCallersRunner) return undefined;
  return { kind: "existing", workspaceId: caller.workspaceId };
};

/** The shipped profile a Thread takes when the user has not set `thread.profileId`. */
const DEFAULT_PROFILE = "unrestricted";

const DEFAULT_ACCESS_MODE: AccessMode = "approval-required";

/**
 * What a Thread takes when the call and the Agent set no value for a field.
 * A field is undefined when the source has no value for it.
 */
interface ThreadDefaults {
  readonly instanceId: string | undefined;
  readonly model: string | undefined;
  /** The options that belong to `model`. */
  readonly options: ModelSelection["options"] | undefined;
  readonly accessMode: AccessMode | undefined;
  readonly permissionProfileId: string | undefined;
  readonly projectId: string | undefined;
  /** The GitHub Connection the Thread pushes as when its workspace names none. */
  readonly githubConnectionId: string | undefined;
}

/**
 * Checks whether the user or a session may start or fork a Thread: the user
 * always may, and a session may when its grants include `thread.start`.
 *
 * Run and plugin actors are refused before this check, with a message of
 * their own: they have no permission profile, so the user has nothing to give
 * them the grant on. That is also why `checkActorHoldsGrant` is not used
 * here: it lets a run pass every grant.
 */
const mayStartThread = (actor: UserActor | SessionActor): boolean =>
  actor._tag === "user" || actor.grants.includes("thread.start");

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
  /** The assistant's conversation the session answers, or undefined for any other session. */
  readonly conversationId: string | undefined;
  /** The workflow run's agent step the session runs, or undefined for any other session. */
  readonly step: WorkspaceStepKey | undefined;
  readonly runnerId: string;
  readonly requestedAccessMode: AccessMode;
  readonly parentSessionId: string | undefined;
  /** The spec the runner receives. Its workspace id is filled in while placing. */
  readonly spec: SessionSpec;
  readonly prompt: string;
  /** The ids of the prompt's images, from `attachment.create`, in order. */
  readonly attachments: ReadonlyArray<string>;
  /** The session's title, or undefined to take it from the prompt. */
  readonly title: string | undefined;
  /** The session's role, or undefined for none. */
  readonly role: string | undefined;
  readonly kind: "session.spawned" | "session.continued";
  /** The audit entry's payload, beyond the new session's id. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projectId: string | undefined;
  /** The workspace the session asked for. When undefined, the spec's workspace is kept. */
  readonly workspace: SpawnWorkspace | undefined;
  /** The GitHub connection the session pushes as when its workspace names none. */
  readonly fallbackGithubConnectionId: string | undefined;
  /**
   * The branch the session's start switches a joined workspace's checkout
   * to, or undefined to take the branch from the workspace it opens. Only a
   * workflow run's first workspace step sets it.
   */
  readonly checkoutBranch: string | undefined;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const rows = yield* sessionRepository;
  const agents = yield* agentRepository;
  const memory = yield* memoryRepository;
  const recordComposer = yield* sessionRecordComposer;
  const workspaces = yield* WorkspaceService;
  const resources = yield* resourceRepository;
  const instances = yield* providerRepository;
  const resolved = yield* resolvedInstance;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const profiles = yield* PermissionProfiles;
  const settings = yield* Settings;
  const promotion = yield* PromotionState;
  const one = readSessionOrFail(rows);
  const resumableNativeSession = yield* resumable;
  const { dispatch } = yield* Dispatch;
  const textGeneration = yield* TextGeneration;
  const forkAfterCommit = yield* makeForkAfterCommit;

  /**
   * Starts writing a title and a role for a new Thread on a background fiber,
   * from its first message, and returns at once. The turn never waits for
   * them and never fails because of them: when the generation fails, the
   * service has already recorded why, and the Thread keeps the cut-short
   * title it was given from the message, and the role it was spawned with, if
   * any.
   */
  const startThreadTitle = (sessionId: string, firstMessage: string): Effect.Effect<void> =>
    forkAfterCommit(
      "Generating a Thread title failed",
      Effect.gen(function* () {
        // The service checks the answer against the JSON Schema, and
        // `ThreadTitleAndRole` has no check that JSON Schema leaves out, so the
        // answer always decodes. Either failure keeps the cut-short title.
        const answer = yield* Effect.option(
          textGeneration
            .generate({
              caller: "core:sessions",
              purpose: "thread.title",
              instructions: THREAD_TITLE_INSTRUCTIONS,
              input: firstMessage.slice(0, MAX_TITLE_INPUT_LENGTH),
              outputSchema: THREAD_TITLE_AND_ROLE_OUTPUT_SCHEMA,
              // A title is only worth having soon; the Thread keeps its
              // cut-short title instead.
              whenNoRunner: "fail",
            })
            .pipe(Effect.flatMap(decodeThreadTitleAndRole)),
        );
        if (Option.isNone(answer)) return;
        yield* promotion.whenServing(sessions.setGeneratedTitleAndRole(sessionId, answer.value));
      }),
    );

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
   * Resolves the runner, the access mode and the model a new session on
   * `instanceId` starts with, in this order:
   *
   * 1. the runner: the one named, or else the first placeable runner;
   * 2. the access mode: the nearest one at or below the requested mode that
   *    the provider supports;
   * 3. the model: the one requested, or else the runner's default model for
   *    the instance, with the requested options checked against it.
   *
   * Returns the runner id, the access mode and the model selection. Fails
   * with `InvalidState` when no runner can take the session, the provider
   * supports no such access mode, or the runner reported no models, and with
   * `Validation` for an unknown instance, runner or option.
   */
  const resolveStartSettings = (request: {
    readonly instanceId: string;
    /** The runner the session must run on, or undefined to let placement choose. */
    readonly runnerId: string | undefined;
    readonly requestedAccessMode: AccessMode;
    /** The model asked for, or undefined for the runner's default. */
    readonly model: string | undefined;
    readonly options: ModelSelection["options"];
  }): Effect.Effect<
    {
      readonly runnerId: string;
      readonly accessMode: AccessMode;
      readonly modelSelection: ModelSelection;
    },
    InvalidState | Validation | SqlError | Schema.SchemaError
  > =>
    Effect.gen(function* () {
      const { definition, snapshots } = yield* resolved(request.instanceId);
      const hosting = yield* request.runnerId === undefined
        ? choosePlacement(snapshots)
        : chooseExplicitRunner(request.runnerId, snapshots);
      const accessMode = findNearestSupportedAccessMode(
        request.requestedAccessMode,
        definition.declared.accessModes,
      );
      if (accessMode === undefined) {
        return yield* Effect.fail(
          createInvalidStateError(
            `${definition.displayName} supports no access mode at or below ${request.requestedAccessMode}`,
          ),
        );
      }
      const model =
        request.model ?? (hosting.models.find((one) => one.isDefault) ?? hosting.models[0])?.slug;
      if (model === undefined) {
        return yield* Effect.fail(
          createInvalidStateError("that runner reported no models for this provider instance"),
        );
      }
      // Options are validated against the model, wherever they came from. An
      // option the model does not offer is rejected by name, even when it
      // came from the Agent, rather than silently dropped.
      yield* validateOptions(hosting.models, model, request.options);
      return {
        runnerId: hosting.runnerId,
        accessMode,
        modelSelection: { model, options: request.options },
      };
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
   * more than the session's own profile. The rule lets an assistant hand work
   * to a worker with fewer grants. A grant the user gave only this session,
   * through a Permission Request decided `session`, does not count: the user
   * gave it to this session, not to the sessions it spawns. Without it, a session could spawn from an Agent
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
        return profile.grants.every((grant) => actor.profileGrants.includes(grant));
      default:
        return false;
    }
  };

  /**
   * Checks whether this actor may open the session with the access mode the
   * call asked for. A per-spawn `accessMode` may override the Agent's access
   * mode.
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

  /**
   * Returns the permission profile that `permissionProfileId` names. Fails
   * with a validation error when no such profile exists.
   */
  const readNamedProfileOrFail = (
    profileId: string,
  ): Effect.Effect<PermissionProfile, Validation | GrantsError | SqlError> =>
    Effect.gen(function* () {
      const found = yield* profiles.getById(profileId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          createValidationError([{ path: ["permissionProfileId"], message: NO_SUCH_PROFILE }]),
        );
      }
      return found.value;
    });

  /**
   * Returns the values a Thread the user starts takes for the fields the call
   * leaves out: the user's `thread.*` settings and
   * `github.defaultConnectionId`. There is no setting for options or a
   * project, so those are undefined.
   */
  const readUserThreadDefaults = (
    userId: string,
  ): Effect.Effect<ThreadDefaults, SettingError | SqlError> =>
    Effect.gen(function* () {
      const values = yield* settings.allForUser(userId);
      return {
        instanceId: values["thread.instanceId"],
        model: values["thread.model"],
        options: undefined,
        accessMode: values["thread.accessMode"],
        permissionProfileId: values["thread.profileId"],
        projectId: undefined,
        githubConnectionId: values["github.defaultConnectionId"] ?? undefined,
      };
    });

  /**
   * Returns the values a Thread a session starts takes for the fields the
   * call leaves out, copied from the calling session's row:
   *
   * - The model and options are copied only when the Thread runs on the
   *   caller's instance (the call names no instance, or the caller's),
   *   because a model belongs to its instance and options to their model.
   * - The Agent-only fields of the row (system prompt, disallowed tools,
   *   output schema) are never copied: a Thread has no Agent.
   * - When the call names no project, the caller's project is copied only
   *   while it exists. A caller whose project was deleted is listed with the
   *   Threads in no project, so a Thread with no project still sits next to
   *   it.
   *
   * A session does not read the user's settings. Its actor carries no user id
   * and a session has no owner, and sessions copy their values instead of
   * referencing them (ADR 0030).
   */
  const copyCallerThreadDefaults = (
    caller: StoredSession,
    call: SessionSpawnInput,
  ): Effect.Effect<ThreadDefaults, SqlError> =>
    Effect.gen(function* () {
      const sameInstance = call.instanceId === undefined || call.instanceId === caller.instanceId;
      return {
        instanceId: caller.instanceId,
        model: sameInstance ? caller.modelSelection.model : undefined,
        options: sameInstance ? caller.modelSelection.options : undefined,
        accessMode: caller.requestedAccessMode,
        permissionProfileId: caller.permissionProfileId,
        projectId:
          call.projectId === undefined &&
          caller.projectId !== null &&
          (yield* resources.liveProjects([caller.projectId])).length > 0
            ? caller.projectId
            : undefined,
        githubConnectionId: caller.githubConnectionId ?? undefined,
      };
    });

  /**
   * Returns the first provider instance that is logged in on some runner. A
   * Thread uses it when the user has not set `thread.instanceId`. Fails with
   * an invalid state error when no instance is logged in.
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
   * Writes the workspace and the session in one transaction, joining the
   * caller's when there is one. Returns the new session's id and the
   * workspace frame the runner must be told about after the commit, if any.
   */
  const writeSession = (
    open: Placing,
  ): Effect.Effect<
    { readonly sessionId: string; readonly frame: WorkspaceProvision | undefined },
    Validation | NotFound | SqlError
  > =>
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
          // what the thread's branch is called and which Connection the work
          // uses.
          const opened = yield* workspaces.openFor({
            holder: { kind: "session", id: sessionId },
            wish: open.workspace,
            heldWorkspaceId: open.spec.workspaceId,
            runnerId: open.runnerId,
            projectId: open.projectId,
            branch: buildThreadBranch(sessionId),
            at,
          });
          yield* sessions.create({
            id: sessionId,
            permissionProfileId: open.permissionProfileId,
            agentId: open.agentId,
            conversationId: open.conversationId,
            step: open.step,
            runnerId: open.runnerId,
            requestedAccessMode: open.requestedAccessMode,
            parentSessionId: open.parentSessionId,
            spec: { ...open.spec, workspaceId: opened.workspaceId },
            prompt: open.prompt,
            attachments: open.attachments,
            title: open.title,
            role: open.role,
            kind: open.kind,
            payload: open.payload,
            projectId: open.projectId,
            checkoutBranch: open.checkoutBranch ?? opened.checkoutBranch,
            // A session pushes as one GitHub account, chosen here: the
            // workspace's own connection if it has one, otherwise the
            // caller's fallback. The fallback is the user's default GitHub
            // Connection for a Thread the user starts and for a conversation
            // session, the calling session's connection for a Thread a session
            // starts, the parent's connection for a fork, and none for a spawn
            // from an Agent.
            githubConnectionId: opened.designatedConnectionId ?? open.fallbackGithubConnectionId,
            at,
          });
          return opened.frame;
        }),
      );
      return { sessionId, frame };
    });

  /**
   * Tells the runner about a new session's workspace, then dispatches, which
   * may start the session. Runs after the commit that wrote the session, so a
   * runner is never told about a row that could still roll back.
   */
  const tellRunnerAndDispatch = (
    runnerId: string,
    frame: WorkspaceProvision | undefined,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      // In the order the runner needs them: it provisions the workspace, and
      // the session is dispatched once the runner reports the workspace ready.
      if (frame !== undefined) yield* connections.tell(runnerId, frame);
      yield* dispatch(runnerId);
    });

  /**
   * Writes the workspace and the session in one transaction, then starts the
   * session. Returns the new session. A transaction never waits on a runner.
   * For a new Thread with a text message, it also starts the call that
   * generates the Thread's title and role.
   *
   * Waits while a promotion freezes the controller. A request was already
   * refused by then, so the wait only holds back a run that places an agent
   * step's session.
   */
  const place = (open: Placing): Effect.Effect<Session, Validation | NotFound | SqlError> =>
    promotion.whenServing(
      Effect.gen(function* () {
        const { sessionId, frame } = yield* writeSession(open);
        yield* tellRunnerAndDispatch(open.runnerId, frame);
        // Read back instead of using the inserted row, so the caller sees
        // `starting` when dispatch started the session at once, not `queued`.
        const after = yield* rows.one(sessionId);
        if (Option.isNone(after)) {
          return yield* Effect.die("a session that was just inserted could not be read back");
        }
        const session = (yield* recordComposer)(after.value);
        // Only a Thread gets a generated title and role: an Agent's session is
        // titled by its caller's work, and a message with only images has no
        // text to title. The call also runs when spawn gave a role, because
        // the title still needs it. A fork of a Thread is a Thread.
        if (open.agentId === undefined && open.prompt.trim() !== "") {
          yield* startThreadTitle(session.id, open.prompt);
        }
        return session;
      }),
    );

  return {
    /**
     * Places a new session that answers an assistant's conversation, with
     * `text` as its first input, inside the caller's transaction. Returns the
     * start, which the caller runs after its commit: it tells the runner and
     * dispatches, so a runner never hears of a session that could roll back.
     *
     * The session runs as the assistant's agent row describes it, with no
     * workspace and no per-call override:
     *
     * - its system prompt starts with the assistant's name, so a rename takes
     *   effect at the next session without editing the persona;
     * - its timeouts include the idle unload, so an unused conversation
     *   frees its runner slot;
     * - it pushes to GitHub as the user's default Connection, if one is set;
     * - it starts with the assistant's memory, `core` in full and the index
     *   of its topics, and with the harness's automatic compaction off,
     *   because the controller rotates the session instead.
     *
     * The memory is read once, here. A resumed session keeps the spec it was
     * placed with (`buildContinuingSpec` copies it), so it keeps the memory
     * it started with, and the assistant's writes since then reach its
     * sessions at the next rotation, which places a new session. The session
     * that made the writes already knows them.
     *
     * It checks no grant: the caller is `conversation.send`, which has
     * checked its own. Fails with `InvalidState` when no runner can take the
     * session or the assistant's profile no longer exists.
     */
    placeConversationSession: (request: {
      readonly conversationId: string;
      readonly assistantId: string;
      readonly text: string;
    }): Effect.Effect<
      Effect.Effect<void, SqlError>,
      | InvalidState
      | NotFound
      | Validation
      | GrantsError
      | SettingError
      | SqlError
      | Schema.SchemaError
    > =>
      Effect.gen(function* () {
        const user = yield* CurrentActor;
        if (user._tag !== "user") {
          return yield* Effect.die("a conversation session is started only by the user's send");
        }
        const row = yield* agents.read(request.assistantId);
        if (Option.isNone(row)) return yield* Effect.fail(createNotFoundError(NO_SUCH_AGENT));
        const agent = row.value;
        if (Option.isNone(yield* profiles.getById(agent.permissionProfileId))) {
          return yield* Effect.fail(
            createInvalidStateError(
              `the assistant's permission profile ${agent.permissionProfileId} no longer exists; ` +
                "point the assistant at another profile, then send again",
            ),
          );
        }
        const { runnerId, accessMode, modelSelection } = yield* resolveStartSettings({
          instanceId: agent.instanceId,
          runnerId: undefined,
          requestedAccessMode: agent.accessMode,
          model: agent.model?.model,
          options: agent.model?.options ?? {},
        });
        const defaults = yield* settings.allForUser(user.userId);
        const core = yield* memory.read(agent.id, MEMORY_CORE);
        const memoryIndex = yield* memory.list(agent.id);

        const spec = {
          instanceId: agent.instanceId,
          workspaceId: null,
          modelSelection,
          accessMode,
          systemPrompt: `Your name is ${agent.name}.\n\n${agent.systemPrompt}`,
          memory: renderSessionMemory(
            Option.match(core, { onNone: () => "", onSome: (document) => document.body }),
            memoryIndex,
          ),
          autoCompaction: false,
          ...(agent.disallowedTools.length === 0 ? {} : { disallowedTools: agent.disallowedTools }),
          timeouts: buildConversationTimeouts(yield* settings.all()),
        } satisfies SessionSpec;

        const { frame } = yield* writeSession({
          permissionProfileId: agent.permissionProfileId,
          agentId: agent.id,
          conversationId: request.conversationId,
          step: undefined,
          runnerId,
          requestedAccessMode: agent.accessMode,
          parentSessionId: undefined,
          spec,
          prompt: request.text,
          attachments: [],
          title: undefined,
          role: undefined,
          kind: "session.spawned",
          projectId: undefined,
          workspace: undefined,
          fallbackGithubConnectionId: defaults["github.defaultConnectionId"] ?? undefined,
          checkoutBranch: undefined,
          payload: {
            instanceId: agent.instanceId,
            runnerId,
            requestedAccessMode: agent.accessMode,
            accessMode,
            agentId: agent.id,
            conversationId: request.conversationId,
          },
        });
        return tellRunnerAndDispatch(runnerId, frame);
      }),

    /**
     * Places a new session for one iteration of a workflow run's agent step,
     * with `prompt` as its first input, inside the caller's transaction.
     * Returns the new session's id and its start, which the caller runs after
     * its commit: it tells the runner and dispatches.
     *
     * The session runs on the run's runner, in the run's workspace when the
     * run has one, and takes its lease on that workspace. Its start switches
     * the workspace's checkout to `checkoutBranch` when that is set. The run
     * engine sets `checkoutBranch` only for the run's first workspace step.
     *
     * Each setting is the step's value if the step sets one, otherwise the
     * Agent's: the model with its options, and the access mode. The Agent
     * gives the instance, the permission profile, the system prompt and the
     * disallowed tools. The step's output schema goes on the spec, and so
     * does an idle unload of a few seconds, so the session frees its runner
     * slot soon after each of its turns ends (`buildStepSessionTimeouts`).
     *
     * It checks no grant: the caller is the run's execution, and the user
     * gave the run this step by saving the workflow. The current actor must
     * be the step's run. Fails with `NotFound` or `InvalidState` when the
     * Agent no longer exists or cannot be run, and with `InvalidState` or
     * `Validation` when the run's runner cannot host the Agent's instance or
     * its settings.
     */
    placeStepSession: (request: {
      readonly step: WorkspaceStepKey;
      readonly agentId: string;
      readonly model: string | undefined;
      readonly options: ModelSelection["options"] | undefined;
      readonly accessMode: AccessMode | undefined;
      readonly outputSchema: SessionSpec["outputSchema"];
      readonly runnerId: string;
      readonly workspaceId: string | null;
      readonly checkoutBranch: string | undefined;
      readonly prompt: string;
      readonly title: string;
    }): Effect.Effect<
      { readonly sessionId: string; readonly start: Effect.Effect<void, SqlError> },
      | InvalidState
      | NotFound
      | Validation
      | GrantsError
      | SettingError
      | SqlError
      | Schema.SchemaError
    > =>
      Effect.gen(function* () {
        // The session is stamped with the current actor, so a session placed
        // by anyone but the step's own run would be attributed wrongly.
        const actor = yield* CurrentActor;
        if (actor._tag !== "run" || actor.runId !== request.step.runId) {
          return yield* Effect.die("an agent step's session is placed only by its own run");
        }
        const { agent } = yield* readAgentWithProfileOrFail(request.agentId);
        const requestedAccessMode = request.accessMode ?? agent.accessMode;
        // A model and its options are one selection, as for a spawn: the
        // Agent's options apply only when the Agent's model is used.
        const agentSelection = request.model === undefined ? agent.model : undefined;
        const { runnerId, accessMode, modelSelection } = yield* resolveStartSettings({
          instanceId: agent.instanceId,
          runnerId: request.runnerId,
          requestedAccessMode,
          model: request.model ?? agentSelection?.model,
          options: request.options ?? agentSelection?.options ?? {},
        });
        const outputSchema = yield* validateOutputSchema(request.outputSchema);

        const spec = {
          instanceId: agent.instanceId,
          // The session joins the run's workspace: `writeSession` opens no
          // workspace of its own when it is given none, and keeps this one.
          workspaceId: request.workspaceId,
          modelSelection,
          accessMode,
          systemPrompt: agent.systemPrompt,
          ...(agent.disallowedTools.length === 0 ? {} : { disallowedTools: agent.disallowedTools }),
          ...(outputSchema === undefined ? {} : { outputSchema }),
          timeouts: buildStepSessionTimeouts(yield* settings.all()),
        } satisfies SessionSpec;

        const { sessionId, frame } = yield* writeSession({
          permissionProfileId: agent.permissionProfileId,
          agentId: agent.id,
          conversationId: undefined,
          step: request.step,
          runnerId,
          requestedAccessMode,
          parentSessionId: undefined,
          spec,
          prompt: request.prompt,
          attachments: [],
          title: request.title,
          role: undefined,
          kind: "session.spawned",
          projectId: undefined,
          workspace: undefined,
          fallbackGithubConnectionId: undefined,
          checkoutBranch: request.checkoutBranch,
          payload: {
            instanceId: agent.instanceId,
            runnerId,
            requestedAccessMode,
            accessMode,
            agentId: agent.id,
            runId: request.step.runId,
            stepId: request.step.stepId,
          },
        });
        return { sessionId, start: tellRunnerAndDispatch(runnerId, frame) };
      }),

    /**
     * Spawns one session: from an Agent, or a Thread when the call names no
     * Agent. Returns the new session.
     *
     * Each field is resolved once, in this order of precedence:
     *
     * 1. the value in this call;
     * 2. the Agent's value, or for a Thread the Thread's defaults
     *    (`readUserThreadDefaults`, `copyCallerThreadDefaults`): the user's
     *    `thread.*` settings when the user starts it, the calling session's
     *    own values when a session does;
     * 3. the instance's default.
     *
     * There is one order only, so there is one answer to "what does this
     * session run under". The model and its options are resolved together, as
     * one selection.
     *
     * Only the user, or a session that holds the `thread.start` grant, may
     * open a Thread; the static check on `session.spawn` cannot tell a Thread
     * from a spawn from an Agent, so this method checks it. A session's
     * overrides are free except for the permission profile: it must grant no
     * more than the session's own profile, or the session could start a Thread
     * on `unrestricted` and drive it. An Agent has a profile of its own, so any
     * actor may spawn from an Agent, up to the grants that actor has, and at
     * or below the Agent's access mode. The user's overrides are unrestricted
     * (spec 13 section 6.3).
     *
     * Where the session runs depends on who spawns it:
     *
     * - The user, a run or a plugin: placement chooses the runner unless the
     *   call names one, and the session gets the workspace the call asks
     *   for, or none.
     * - A session: the spawn runs on the caller's runner unless the call
     *   names one, and in the caller's workspace unless the call names a
     *   workspace or another runner (`chooseWorkspaceNextToCaller`). The
     *   caller's runner counts as named, so a reserved runner takes the
     *   spawn and a draining one refuses it.
     *
     * A requested new workspace is provisioned before the harness starts in
     * it.
     */
    placeSession: (input: SessionSpawnInput): Effect.Effect<Session, PlaceError | NotFound> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("session.spawn");
        const decoded = yield* Effect.mapError(decodeSpawn(input), createDecodeValidationError);
        if (decoded.agentId !== undefined) yield* refuseAgentOwnedFields(decoded);
        // The calling session, when a session spawns: its spawn runs next to
        // it unless the call says where.
        const caller = actor._tag === "session" ? yield* one(actor.sessionId) : undefined;
        const spawnedFrom =
          decoded.agentId === undefined
            ? undefined
            : yield* readAgentWithProfileOrFail(decoded.agentId);
        const agent = spawnedFrom?.agent;
        // The Thread's defaults: undefined for a spawn from an Agent, which
        // takes every default from the Agent.
        let threadDefaults: ThreadDefaults | undefined;
        if (spawnedFrom === undefined) {
          if (actor._tag !== "user" && actor._tag !== "session") {
            return yield* Effect.fail(
              createForbiddenError("session.spawn", THREAD_NEEDS_A_PROFILE),
            );
          }
          if (!mayStartThread(actor)) {
            return yield* Effect.fail(
              createForbiddenError("thread.start", START_THREAD_NEEDS_GRANT),
            );
          }
          if (decoded.workspace?.kind === "primary" && decoded.workspace.branch !== undefined) {
            return yield* Effect.fail(
              createValidationError([
                {
                  path: ["workspace", "branch"],
                  message:
                    "Threads leave the existing checkout's branch unchanged. Omit branch to share its files, or choose an ephemeral workspace with startingRevision for separate work.",
                },
              ]),
            );
          }
          if (decoded.permissionProfileId !== undefined) {
            const named = yield* readNamedProfileOrFail(decoded.permissionProfileId);
            if (!mayRunAs(actor, named)) {
              return yield* Effect.fail(
                createForbiddenError("thread.start", THREAD_PROFILE_NOT_ITS_GRANTS),
              );
            }
          }
          // `caller` is the session's row whenever the actor is a session.
          if (actor._tag === "user") threadDefaults = yield* readUserThreadDefaults(actor.userId);
          else if (caller !== undefined) {
            threadDefaults = yield* copyCallerThreadDefaults(caller, decoded);
          }
        } else {
          if (!mayRunAs(actor, spawnedFrom.profile)) {
            return yield* Effect.fail(createForbiddenError("session.spawn", NOT_ITS_GRANTS));
          }
          if (!mayRunOn(actor, decoded.accessMode, spawnedFrom.agent)) {
            return yield* Effect.fail(createForbiddenError("session.spawn", NOT_ITS_ACCESS_MODE));
          }
        }
        const outputSchema = yield* validateOutputSchema(decoded.outputSchema);
        if (decoded.projectId !== undefined) yield* validateLiveProject(decoded.projectId);
        const projectId = decoded.projectId ?? threadDefaults?.projectId;
        // A session's spawn runs on the caller's runner and in the caller's
        // workspace unless the call names its own. The user's and the
        // system's spawns name everything they want, and placement chooses
        // the rest.
        const workspace =
          caller === undefined ? decoded.workspace : chooseWorkspaceNextToCaller(caller, decoded);
        // Read before placement: an existing workspace decides which runner the
        // session runs on, because that is where its files are.
        const pinnedTo =
          workspace?.kind === "existing"
            ? yield* workspaces.machineFor(workspace.workspaceId, decoded.runnerId)
            : undefined;
        // An override applies to this session only and is not written back to
        // the settings.
        const instanceId =
          decoded.instanceId ??
          agent?.instanceId ??
          threadDefaults?.instanceId ??
          (yield* pickLoggedInInstance());
        const requestedAccessMode =
          decoded.accessMode ??
          agent?.accessMode ??
          threadDefaults?.accessMode ??
          DEFAULT_ACCESS_MODE;
        // A model and its options are one selection: options belong to the
        // model that offers them. So the Agent's or the Thread default's
        // options apply only when the call names no model of its own. A call
        // that names its own model uses the options it sent with that model,
        // or none at all.
        const defaultOptions =
          decoded.model === undefined
            ? (agent?.model?.options ?? threadDefaults?.options)
            : undefined;
        const { runnerId, accessMode, modelSelection } = yield* resolveStartSettings({
          instanceId,
          runnerId: pinnedTo ?? decoded.runnerId ?? caller?.runnerId,
          requestedAccessMode,
          model: decoded.model ?? agent?.model?.model ?? threadDefaults?.model,
          options: decoded.options ?? defaultOptions ?? {},
        }).pipe(
          Effect.mapError((error) =>
            caller !== undefined &&
            decoded.runnerId === undefined &&
            decoded.workspace?.kind !== "existing" &&
            error instanceof InvalidState
              ? createInvalidStateError(`${error.error.message}; ${FOLLOWED_CALLER}`)
              : error,
          ),
        );

        const profileId =
          decoded.permissionProfileId ??
          agent?.permissionProfileId ??
          threadDefaults?.permissionProfileId ??
          (yield* readThreadProfileId());

        const spec = {
          instanceId,
          workspaceId: null,
          modelSelection,
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
          conversationId: undefined,
          step: undefined,
          runnerId,
          requestedAccessMode,
          parentSessionId: undefined,
          spec,
          prompt: decoded.prompt,
          attachments: decoded.attachments ?? [],
          title: undefined,
          role: decoded.role,
          kind: "session.spawned",
          projectId,
          workspace,
          fallbackGithubConnectionId: threadDefaults?.githubConnectionId,
          checkoutBranch: undefined,
          payload: {
            instanceId,
            runnerId,
            requestedAccessMode,
            accessMode,
            ...(agent === undefined ? {} : { agentId: agent.id }),
            ...(projectId === undefined ? {} : { projectId }),
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
     * Only the user, or a session that holds the `thread.start` grant, may
     * fork a Thread. The fork keeps the parent's lineage, so a fork of a
     * Thread is a new Thread. If any other actor could fork one, it could
     * open a Thread with a prompt of its own choosing, which `session.spawn`
     * refuses without the grant. Forking an Agent's session needs no
     * `thread.start`.
     *
     * The fork takes the parent's profile rather than the user's thread
     * defaults. So a session may fork a session only from a parent on its own
     * profile. Any other parent would be an escalation: `session.read` is
     * unscoped, so a session can find every other session, and forking one on
     * a wider profile would give it that profile's grants with a prompt of
     * its own choosing.
     */
    continueSession: (input: ContinueInput): Effect.Effect<Session, ContinueError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("session.continue");
        const { id, mode, prompt, attachments } = yield* Effect.mapError(
          decodeContinue(input),
          createDecodeValidationError,
        );
        const parent = yield* one(id);
        if (parent.conversationId !== null) {
          return yield* Effect.fail(createInvalidStateError(CONVERSATION_FORK_REFUSED));
        }
        if (parent.agentId === null) {
          if (actor._tag !== "user" && actor._tag !== "session") {
            return yield* Effect.fail(
              createForbiddenError("session.spawn", THREAD_NEEDS_A_PROFILE),
            );
          }
          if (!mayStartThread(actor)) {
            return yield* Effect.fail(
              createForbiddenError("thread.start", FORK_THREAD_NEEDS_GRANT),
            );
          }
        }
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
          conversationId: undefined,
          step: undefined,
          runnerId: parent.runnerId,
          requestedAccessMode: parent.requestedAccessMode,
          parentSessionId: parent.id,
          // A fork continues under the parent's spec, in the parent's
          // workspace and project. It is the same piece of work, branched.
          spec: buildContinuingSpec(
            yield* sessions.readSpec(parent.id),
            yield* settings.all(),
            parent.modelSelection,
            // A continuation is a new session with no subagent records, so
            // it names no subagents, whatever its mode.
            { nativeSessionId, mode },
            // A fork never answers a conversation: `session.continue`
            // refuses a conversation's session above. Nor does it run a
            // step, even when its parent did: it is placed with no step.
            { conversationId: null, runId: null },
          ),
          prompt,
          attachments: attachments ?? [],
          title: undefined,
          // A fork takes no role from its parent: a fork of a Thread gets a
          // generated one, like any Thread.
          role: undefined,
          kind: "session.continued",
          projectId: parent.projectId ?? undefined,
          workspace: undefined,
          fallbackGithubConnectionId: parent.githubConnectionId ?? undefined,
          checkoutBranch: undefined,
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
  | PromotionState
  | TextGeneration
> = Layer.effect(Placement)(make);
