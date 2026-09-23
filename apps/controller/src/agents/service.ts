/**
 * The agent operations: `agent.query`, `read`, `create`, `update` and `delete`.
 *
 * An Agent is configuration and nothing else. A spawn copies the values it uses
 * onto the Session, and nothing reads a running or past session back through
 * the Agent (ADR 0030). Therefore an edit is safe while sessions run. A delete
 * is rejected only while a session this agent spawned has not exited. After that
 * the agent's id on those rows is lineage only.
 *
 * An agent names a provider instance and a permission profile, which are rows
 * in other domains. Both are checked at create and at update, because an
 * agent that names a row that does not exist would spawn nothing, and the user
 * would learn that at the first spawn instead of when making the mistake.
 *
 * `unenforced` is not stored. It is computed from the provider's declaration
 * on every read, so it reflects this binary, not the older binary that may
 * have written the row.
 *
 * Every mutation writes one event in the transaction that writes the row. The
 * actor is stamped here, on the event envelope.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AccessMode, ModelSelection } from "@hercule/protocol";
import {
  AGENT_SORT_FIELDS,
  AgentCreateInput,
  AgentFilter,
  AgentUpdateInput,
  DEFAULT_PAGE_LIMIT,
  Id,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  type Agent,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, buildPageInputFields, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PermissionProfiles, type GrantsError } from "../permissions";
import { PluginHost } from "../plugins";
import { providerRepository, listUnenforcedFields } from "../providers";
import { LIVE_SESSION_STATUSES, sessionRepository } from "../sessions";
import { agentRepository, type AgentEdit, type StoredAgent } from "./repository";

const QueryInput = Schema.Struct({
  ...AgentFilter.fields,
  ...buildPageInputFields(AGENT_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...AgentUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(AgentCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

export interface AgentPage {
  readonly items: ReadonlyArray<Agent>;
  readonly nextCursor?: string;
}

/** Newest first: an agent list is read as a history of what has been set up. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/**
 * The access mode of an agent that sets none. Its sessions work unattended, so
 * they do not ask for approval.
 */
const DEFAULT_ACCESS_MODE: AccessMode = "full-access";

const NO_SUCH_AGENT = "no such agent";

const NO_SUCH_PROFILE = "no such permission profile";

const NO_SUCH_INSTANCE = "no such provider instance";

/** The message for options sent without a model, and what to send instead. */
const NO_MODEL_FOR_OPTIONS =
  "options belong to one model, so send model too: " +
  "the slug of the agent's current model, or of the model you are switching to";

/**
 * Combines the two API fields, `model` and `options`, into the one selection
 * the record stores. Returns `undefined` when the call sets neither: on an
 * update the stored selection stays as it was, and on a create the agent uses
 * the instance's default model. Returns null when `model` is null.
 *
 * Fails with `Validation` if options are sent without a model. A choice
 * belongs to the model that offers it. If the choice were kept and moved to
 * another model, the agent would run with a value that model never declared.
 */
const buildModelSelection = (
  model: string | null | undefined,
  options: ModelSelection["options"] | undefined,
): Effect.Effect<ModelSelection | null | undefined, Validation> => {
  if (typeof model !== "string" && options !== undefined) {
    return Effect.fail(
      createValidationError([{ path: ["options"], message: NO_MODEL_FOR_OPTIONS }]),
    );
  }
  if (model === undefined) return Effect.succeed(undefined);
  return Effect.succeed(model === null ? null : { model, options: options ?? {} });
};

/**
 * The errors every operation can fail with. `SchemaError` comes from the
 * provider catalog: reading what a provider declares decodes that provider's
 * stored config, and every operation here reads it to report `unenforced`.
 */
type ReadError = Unauthenticated | Forbidden | Validation | SqlError | Schema.SchemaError;

type WriteError = ReadError | GrantsError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const agents = yield* agentRepository;
  // The sessions domain knows whether a session this agent spawned is still
  // live. This uses its repository, not its service, because the service
  // enforces `session.query` on the caller, and deleting an agent is not a
  // read of anybody's sessions.
  const sessions = yield* sessionRepository;
  const instances = yield* providerRepository;
  const host = yield* PluginHost;
  const profiles = yield* PermissionProfiles;
  const audit = yield* AuditLog;

  /**
   * Returns a function that builds the API record from a stored agent, with
   * `unenforced` computed from the provider's declaration. The provider
   * catalog is read once from memory, so one function serves a whole page as
   * well as a single agent.
   */
  const agentRecordComposer = Effect.map(
    host.providers(),
    (definitions) =>
      ({ providerId, ...agent }: StoredAgent): Agent => ({
        ...agent,
        unenforced: listUnenforcedFields(definitions, providerId, agent.disallowedTools),
      }),
  );

  /**
   * Returns the provider id of the instance an agent names. Fails with
   * `Validation` if the instance does not exist, or if this build does not
   * include its provider. It does not check what the machines that host the
   * provider can do now: an agent is a stored configuration, not a placement.
   */
  const readProviderIdOrFail = (instanceId: string): Effect.Effect<string, WriteError> =>
    Effect.gen(function* () {
      const instance = yield* instances.one(instanceId);
      if (Option.isNone(instance)) {
        return yield* Effect.fail(
          createValidationError([{ path: ["instanceId"], message: NO_SUCH_INSTANCE }]),
        );
      }
      const providerId = instance.value.providerId;
      const definitions = yield* host.providers();
      if (!definitions.some((definition) => definition.id === providerId)) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["instanceId"],
              message:
                `this build carries no ${providerId} provider; ` +
                "name an instance of a provider this build carries",
            },
          ]),
        );
      }
      return providerId;
    });

  /**
   * Checks that a `permissionProfileId` matches a profile before it is
   * written. Fails with `Validation` if it does not.
   */
  const validateProfileExists = (profileId: string): Effect.Effect<void, WriteError> =>
    Effect.gen(function* () {
      const profile = yield* profiles.getById(profileId);
      if (Option.isNone(profile)) {
        return yield* Effect.fail(
          createValidationError([{ path: ["permissionProfileId"], message: NO_SUCH_PROFILE }]),
        );
      }
    });

  /** Returns the stored agent, or fails with `NotFound` if no agent has this id. */
  const readAgentOrFail = (id: string): Effect.Effect<StoredAgent, NotFound | SqlError> =>
    Effect.flatMap(
      agents.read(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_AGENT)),
        onSome: Effect.succeed,
      }),
    );

  return {
    /** Returns one page of the agents, newest first by default. */
    query: (input: QueryInput): Effect.Effect<AgentPage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.query");
        const { limit, cursor, sort, permissionProfileId } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const listing = yield* refuseCursor(
          agents.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            permissionProfileId,
          }),
        );
        const composeRecord = yield* agentRecordComposer;
        return {
          items: listing.items.map(composeRecord),
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (input: Identified): Effect.Effect<Agent, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        const composeRecord = yield* agentRecordComposer;
        return composeRecord(yield* readAgentOrFail(id));
      }),

    /**
     * Creates an agent that sessions can be spawned from, and returns it. Fails
     * with `Validation` if the instance or the permission profile does not
     * exist.
     */
    create: (input: AgentCreateInput): Effect.Effect<Agent, WriteError> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const selection = yield* buildModelSelection(decoded.model, decoded.options);
        const composeRecord = yield* agentRecordComposer;
        const stored = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Both reads are inside the write set. An instance or a profile
            // read before the transaction can be deleted between that read and
            // the insert, which would store an agent that names a row that is
            // gone.
            const providerId = yield* readProviderIdOrFail(decoded.instanceId);
            yield* validateProfileExists(decoded.permissionProfileId);
            // One clock read, inside the transaction. The row and the event
            // that records the row carry the same instant, so a new agent's
            // `updatedAt` is equal to its `createdAt`.
            const at = yield* nowIso;
            const agent = yield* agents.insert({
              providerId,
              name: decoded.name,
              systemPrompt: decoded.systemPrompt,
              instanceId: decoded.instanceId,
              permissionProfileId: decoded.permissionProfileId,
              accessMode: decoded.accessMode ?? DEFAULT_ACCESS_MODE,
              model: selection ?? null,
              disallowedTools: decoded.disallowedTools ?? [],
              at,
            });
            yield* audit.append({
              kind: "agent.created",
              actor: yield* currentStamp,
              // Ids and the name only. Every actor that holds `event.read`
              // can read the log, and an agent's prompt is its instructions.
              payload: {
                agentId: agent.id,
                name: agent.name,
                instanceId: agent.instanceId,
                permissionProfileId: agent.permissionProfileId,
              },
              at,
            });
            return agent;
          }),
        );
        return composeRecord(stored);
      }),

    /**
     * Updates an agent and returns it. Only sessions spawned afterwards use the
     * new values. Fails with `Validation` if no field is set or a named
     * instance or profile does not exist, and with `NotFound` if the agent
     * does not exist.
     */
    update: (input: UpdateInput): Effect.Effect<Agent, WriteError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.update");
        const { id, model, options, ...named } = yield* Effect.mapError(
          decodeUpdate(input),
          createDecodeValidationError,
        );
        const selection = yield* buildModelSelection(model, options);
        const edit: AgentEdit = {
          ...named,
          ...(selection === undefined ? {} : { model: selection }),
        };
        if (Object.keys(edit).length === 0) {
          return yield* Effect.fail(
            createValidationError([{ path: [], message: "name a field to change" }]),
          );
        }
        const composeRecord = yield* agentRecordComposer;
        const stored = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Inside the write set. A profile or an instance that is deleted
            // between the check and the update would leave the agent naming a
            // row that is gone.
            if (edit.instanceId !== undefined) yield* readProviderIdOrFail(edit.instanceId);
            if (edit.permissionProfileId !== undefined) {
              yield* validateProfileExists(edit.permissionProfileId);
            }
            const at = yield* nowIso;
            // Read only so that an unknown id fails with `not_found`, instead
            // of an update that changes no rows and reports success.
            yield* readAgentOrFail(id);
            yield* agents.update(id, edit, at);
            yield* audit.append({
              kind: "agent.updated",
              actor: yield* currentStamp,
              // Which fields changed, never their new values. The values are
              // the agent's instructions and its configuration.
              payload: { agentId: id, changed: Object.keys(edit).sort() },
              at,
            });
            return yield* readAgentOrFail(id);
          }),
        );
        return composeRecord(stored);
      }),

    /**
     * Deletes an agent. Fails with `InvalidState` while a session this agent
     * spawned has not exited. Such a session keeps the agent's id after the
     * delete: the session is history, and it runs on its own copy of every
     * value the agent gave it.
     */
    delete: (
      input: Identified,
    ): Effect.Effect<Record<string, never>, WriteError | NotFound | InvalidState> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.delete");
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const agent = yield* readAgentOrFail(id);
            // The oldest session this agent spawned that has not exited. It is
            // named in the error, so the user knows which session to end.
            const live = yield* refuseCursor(
              sessions.list({
                limit: 1,
                cursor: undefined,
                direction: "asc",
                status: LIVE_SESSION_STATUSES,
                runnerId: undefined,
                agentId: id,
                permissionProfileId: undefined,
                thread: undefined,
              }),
            );
            const running = live.items[0];
            if (running !== undefined) {
              return yield* Effect.fail(
                createInvalidStateError(
                  `session ${running.id} was spawned from this agent and has not exited; ` +
                    "end it first, then delete the agent",
                ),
              );
            }
            yield* agents.delete(id);
            yield* audit.append({
              kind: "agent.deleted",
              actor: yield* currentStamp,
              payload: { agentId: id, name: agent.name },
              at,
            });
          }),
        );
        return {};
      }),
  };
});

/** The agent service. */
export class AgentService extends Context.Service<AgentService, Effect.Success<typeof make>>()(
  "hercule/controller/agents/AgentService",
) {}

export const AgentServiceLayer: Layer.Layer<
  AgentService,
  never,
  SqlClient.SqlClient | AuditLog | PermissionProfiles | PluginHost
> = Layer.effect(AgentService)(make);
