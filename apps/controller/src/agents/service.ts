/**
 * The agent operations: `agent.query`, `read`, `create`, `update` and `delete`.
 *
 * An Agent is configuration and nothing else. A spawn copies the values it uses
 * onto the Session, and nothing reads a running or past session back through
 * the Agent (ADR 0030). Therefore an edit is safe while sessions run. A delete
 * is rejected only while a session this agent spawned has not exited. After that
 * the agent's id on those rows is lineage only.
 *
 * An assistant is an agent too, with an agent row of kind `assistant`. These
 * operations read that row, so every session's `agentId` resolves, but they
 * do not list it and refuse to change it: the assistant operations own it.
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
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AccessMode } from "@hercule/protocol";
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
import { LIVE_SESSION_STATUSES, sessionRepository } from "../sessions";
import { buildAgentFieldChecks, buildModelSelection } from "./fields";
import { agentRepository, type AgentEdit, type StoredAgent } from "./repository";

const QueryInput = Schema.Struct({
  ...AgentFilter.fields,
  ...buildPageInputFields(AGENT_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...AgentUpdateInput.fields });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(AgentCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);

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

/**
 * The message for an agent update or delete of an assistant's agent row. An
 * assistant has more rows than its agent row, and only the assistant
 * operations keep them together.
 */
const ASSISTANT_CHANGE_REFUSED =
  "this agent is an assistant; use assistant.update or assistant.delete";

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
  const { buildAgentRecordComposer, readProviderIdOrFail, validateProfileExists } =
    yield* buildAgentFieldChecks;
  const audit = yield* AuditLog;

  /** Returns the stored agent, or fails with `NotFound` if no agent has this id. */
  const readAgentOrFail = (id: string): Effect.Effect<StoredAgent, NotFound | SqlError> =>
    Effect.flatMap(
      agents.read(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_AGENT)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Returns the stored agent for a write. Fails with `NotFound` if no agent
   * has this id, and with `InvalidState` if the agent belongs to an assistant.
   */
  const readPlainAgentOrFail = (
    id: string,
  ): Effect.Effect<StoredAgent, NotFound | InvalidState | SqlError> =>
    Effect.flatMap(readAgentOrFail(id), (agent) =>
      agent.kind === "assistant"
        ? Effect.fail(createInvalidStateError(ASSISTANT_CHANGE_REFUSED))
        : Effect.succeed(agent),
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
            // An assistant is chatted with, not spawned from, so agent pickers
            // must never offer one.
            kind: "agent",
          }),
        );
        const composeRecord = yield* buildAgentRecordComposer;
        return {
          items: listing.items.map(composeRecord),
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (id: Id): Effect.Effect<Agent, Exclude<ReadError | NotFound, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.read");
        const composeRecord = yield* buildAgentRecordComposer;
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
        const composeRecord = yield* buildAgentRecordComposer;
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
              kind: "agent",
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
     * instance or profile does not exist, with `NotFound` if the agent does
     * not exist, and with `InvalidState` if the agent belongs to an assistant.
     */
    update: (input: UpdateInput): Effect.Effect<Agent, WriteError | NotFound | InvalidState> =>
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
        const composeRecord = yield* buildAgentRecordComposer;
        const stored = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Read first, so that an unknown id fails with `not_found` instead
            // of an update that changes no rows and reports success, and an
            // assistant is refused before its fields are checked.
            yield* readPlainAgentOrFail(id);
            // Inside the write set. A profile or an instance that is deleted
            // between the check and the update would leave the agent naming a
            // row that is gone.
            if (edit.instanceId !== undefined) yield* readProviderIdOrFail(edit.instanceId);
            if (edit.permissionProfileId !== undefined) {
              yield* validateProfileExists(edit.permissionProfileId);
            }
            const at = yield* nowIso;
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
     * Deletes an agent. Fails with `InvalidState` if the agent belongs to an
     * assistant, or while a session this agent spawned has not exited. Such a
     * session keeps the agent's id after the delete: the session is history,
     * and it runs on its own copy of every value the agent gave it.
     */
    delete: (id: Id): Effect.Effect<Record<string, never>, WriteError | NotFound | InvalidState> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.delete");
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const agent = yield* readPlainAgentOrFail(id);
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
