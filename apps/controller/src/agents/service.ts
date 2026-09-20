/**
 * Agents as the API sees them: `agent.query`, `read`, `create`, `update` and
 * `delete`.
 *
 * An Agent is configuration and nothing else. A spawn copies the values it uses
 * onto the Session, and nothing reads a running or past session back through
 * the Agent (ADR 0030). Therefore an edit is safe while sessions run. A delete
 * is refused only while a session this agent spawned has not exited. After that
 * the agent's id on those rows is lineage only.
 *
 * An agent names a provider instance and a permission profile, which are rows
 * in other domains. Both are read at create and at update, because an agent
 * that names a row that does not exist would spawn nothing, and the user would
 * learn that at the first spawn instead of at the mistake.
 *
 * `unenforced` is not stored. What a provider acts on is read from the
 * provider's declaration at every read, so the answer follows this binary and
 * not the row that an older binary wrote.
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
  invalidState,
  notFound,
  validation,
  validationOf,
  type Agent,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PermissionProfiles, type GrantsError } from "../permissions";
import { PluginHost } from "../plugins";
import { providerRepository, listUnenforcedFields } from "../providers";
import { LIVE_SESSION_STATUSES, sessionRepository } from "../sessions";
import { agentRepository, type AgentEdit, type StoredAgent } from "./repository";

const QueryInput = Schema.Struct({
  ...AgentFilter.fields,
  ...pageInput(AGENT_SORT_FIELDS),
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

/** What an agent's sessions may do unasked where the agent says nothing: they work unattended. */
const DEFAULT_ACCESS_MODE: AccessMode = "full-access";

const NO_SUCH_AGENT = "no such agent";

const NO_SUCH_PROFILE = "no such permission profile";

const NO_SUCH_INSTANCE = "no such provider instance";

/** Why options with no model beside them are refused, and what to send instead. */
const NO_MODEL_FOR_OPTIONS =
  "options are the choices of one model, so name the model too: " +
  "send model with the slug the agent is on, or with the slug you move it to";

/**
 * Folds the two fields the API takes, `model` and `options`, into the one
 * selection the record holds. `undefined` is a call that named neither. On an
 * edit that leaves the stored selection as it was. On a create it means the
 * instance's own default model.
 *
 * Options without a model are refused. A choice belongs to the model that
 * offers it. If the choice were kept and put on another model, the agent would
 * run on a value that model never declared.
 */
const buildModelSelection = (
  model: string | null | undefined,
  options: ModelSelection["options"] | undefined,
): Effect.Effect<ModelSelection | null | undefined, Validation> => {
  if (typeof model !== "string" && options !== undefined) {
    return Effect.fail(validation([{ path: ["options"], message: NO_MODEL_FOR_OPTIONS }]));
  }
  if (model === undefined) return Effect.succeed(undefined);
  return Effect.succeed(model === null ? null : { model, options: options ?? {} });
};

/**
 * How every call can refuse. `SchemaError` comes from the provider catalog:
 * reading what a provider declares decodes that provider's stored config, and
 * every operation here reads it to report `unenforced`.
 */
type ReadError = Unauthenticated | Forbidden | Validation | SqlError | Schema.SchemaError;

type WriteError = ReadError | GrantsError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const agents = yield* agentRepository;
  // Whether a session this agent spawned is still live is the sessions
  // domain's question, and this is where it is asked. The repository and not
  // the service: the service enforces `session.query` on whoever is calling,
  // and a delete of one's own agent is not a read of anybody's sessions.
  const sessions = yield* sessionRepository;
  const instances = yield* providerRepository;
  const host = yield* PluginHost;
  const profiles = yield* PermissionProfiles;
  const audit = yield* AuditLog;

  /**
   * Composes the record from the row, and reads `unenforced` from the
   * provider's declaration. The catalog is one read from memory, so one
   * composer answers a whole page as well as a single agent.
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
   * Answers which provider is behind the instance an agent names. Refuses an
   * instance that does not exist, and an instance whose provider this build
   * does not carry. What the machines that host the provider can do now is not
   * read: an agent is a stored configuration, not a placement.
   */
  const requireProvider = (instanceId: string): Effect.Effect<string, WriteError> =>
    Effect.gen(function* () {
      const instance = yield* instances.one(instanceId);
      if (Option.isNone(instance)) {
        return yield* Effect.fail(
          validation([{ path: ["instanceId"], message: NO_SUCH_INSTANCE }]),
        );
      }
      const providerId = instance.value.providerId;
      const definitions = yield* host.providers();
      if (!definitions.some((definition) => definition.id === providerId)) {
        return yield* Effect.fail(
          validation([
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

  /** Refuses a `permissionProfileId` naming no profile, before it is written as one. */
  const requireProfile = (profileId: string): Effect.Effect<void, WriteError> =>
    Effect.gen(function* () {
      const profile = yield* profiles.getById(profileId);
      if (Option.isNone(profile)) {
        return yield* Effect.fail(
          validation([{ path: ["permissionProfileId"], message: NO_SUCH_PROFILE }]),
        );
      }
    });

  /** The stored agent, or `not_found` if no agent has this id. */
  const requireAgent = (id: string): Effect.Effect<StoredAgent, NotFound | SqlError> =>
    Effect.flatMap(
      agents.read(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_AGENT)),
        onSome: Effect.succeed,
      }),
    );

  return {
    /** One page of the agents, newest first. */
    query: (input: QueryInput): Effect.Effect<AgentPage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.query");
        const { limit, cursor, sort, permissionProfileId } = yield* Effect.mapError(
          decodeQuery(input),
          validationOf,
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
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        const composeRecord = yield* agentRecordComposer;
        return composeRecord(yield* requireAgent(id));
      }),

    /** Records a configuration sessions can be spawned from. */
    create: (input: AgentCreateInput): Effect.Effect<Agent, WriteError> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), validationOf);
        const selection = yield* buildModelSelection(decoded.model, decoded.options);
        const composeRecord = yield* agentRecordComposer;
        const stored = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Both reads are inside the write set. An instance or a profile
            // read before the transaction can be deleted between that read and
            // the insert, which would store an agent that names a row that is
            // gone.
            const providerId = yield* requireProvider(decoded.instanceId);
            yield* requireProfile(decoded.permissionProfileId);
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

    /** Changes what sessions spawned from here on will run under. */
    update: (input: UpdateInput): Effect.Effect<Agent, WriteError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.update");
        const { id, model, options, ...named } = yield* Effect.mapError(
          decodeUpdate(input),
          validationOf,
        );
        const selection = yield* buildModelSelection(model, options);
        const edit: AgentEdit = {
          ...named,
          ...(selection === undefined ? {} : { model: selection }),
        };
        if (Object.keys(edit).length === 0) {
          return yield* Effect.fail(validation([{ path: [], message: "name a field to change" }]));
        }
        const composeRecord = yield* agentRecordComposer;
        const stored = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Inside the write set. A profile or an instance that is deleted
            // between the check and the update would leave the agent naming a
            // row that is gone.
            if (edit.instanceId !== undefined) yield* requireProvider(edit.instanceId);
            if (edit.permissionProfileId !== undefined) {
              yield* requireProfile(edit.permissionProfileId);
            }
            const at = yield* nowIso;
            // Read for the refusal it can give. An id that no agent holds
            // must answer `not_found`, and not an update that changed no rows
            // and reported success.
            yield* requireAgent(id);
            yield* agents.update(id, edit, at);
            yield* audit.append({
              kind: "agent.updated",
              actor: yield* currentStamp,
              // Which fields changed, never their new values. The values are
              // the agent's instructions and its configuration.
              payload: { agentId: id, changed: Object.keys(edit).sort() },
              at,
            });
            return yield* requireAgent(id);
          }),
        );
        return composeRecord(stored);
      }),

    /**
     * Removes an agent that no session runs under any more. A session this
     * agent spawned keeps the agent's id. The session is history, and it runs
     * on its own copy of every value the agent gave it.
     */
    delete: (
      input: Identified,
    ): Effect.Effect<Record<string, never>, WriteError | NotFound | InvalidState> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.delete");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const agent = yield* requireAgent(id);
            // The oldest session this agent spawned that has not exited. It is
            // named in the refusal, so the user knows which session to end.
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
                invalidState(
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
  "hydra/controller/agents/AgentService",
) {}

export const AgentServiceLayer: Layer.Layer<
  AgentService,
  never,
  SqlClient.SqlClient | AuditLog | PermissionProfiles | PluginHost
> = Layer.effect(AgentService)(make);
