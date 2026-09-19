/**
 * Agents as the API sees them: `agent.query`, `read`, `create`, `update` and
 * `delete`.
 *
 * An Agent is configuration and nothing else: a spawn copies the values it uses
 * onto the Session, and no property of a running or past session is ever read
 * back through it (ADR 0030). That is what makes an edit here safe while
 * sessions are running, and it is why a delete is refused only while a session
 * it spawned has not exited - after that the agent's id on those rows is
 * lineage, pointing at nothing anyone still has to read.
 *
 * Two of the four values an agent names live in other domains - a provider
 * instance and a permission profile - and both are read for what they refuse:
 * an agent that names one of them wrongly would spawn nothing and say so only
 * at the first spawn, long after the mistake was made.
 *
 * `unenforced` is not stored. What a provider will act on is read from its
 * declaration at every read, so the answer follows the binary rather than the
 * row that was written under an older one.
 *
 * Every mutation writes one event in the same transaction as the row it
 * describes. The actor is stamped here, on the event envelope.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AccessMode, ModelSelection } from "@hydra/protocol";
import {
  AGENT_SORT_FIELDS,
  AgentCreateInput,
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
} from "@hydra/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PermissionProfiles, type GrantsError } from "../permissions";
import { PluginHost } from "../plugins";
import { providerRepository, unenforcedFieldsIn } from "../providers";
import { agentRepository, type AgentEdit, type StoredAgent } from "./repository";

const QueryInput = Schema.Struct(pageInput(AGENT_SORT_FIELDS));

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

/** Why options with no model beside them are refused. */
const NO_MODEL_FOR_OPTIONS =
  "name a model beside the options: a model's choices are the choices that model offers";

/**
 * The one selection the record holds, folded from the two fields the API takes
 * it as. `undefined` is a call that named neither, which on an edit leaves the
 * stored selection alone and on a create is the instance's own default model.
 *
 * Options with no model beside them are refused rather than applied to
 * whatever model the agent happens to be on: a choice belongs to the model
 * that offers it, and one carried onto another model is a value that model
 * never declared.
 */
const foldedSelection = (
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
 * How every call can refuse. `SchemaError` is the provider catalog's: reading
 * what a provider declares decodes its stored config, and every operation here
 * reads it to say what that provider will not enforce.
 */
type ReadError = Unauthenticated | Forbidden | Validation | SqlError | Schema.SchemaError;

type WriteError = ReadError | GrantsError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const agents = yield* agentRepository;
  const instances = yield* providerRepository;
  const host = yield* PluginHost;
  const profiles = yield* PermissionProfiles;
  const audit = yield* AuditLog;

  /**
   * The record, with what its provider will ignore of it read fresh off that
   * provider's declaration. The catalog is one in-memory read, so one of these
   * answers a whole page as readily as a single agent.
   */
  const recordReader = Effect.map(
    host.providers(),
    (definitions) =>
      ({ providerId, ...agent }: StoredAgent): Agent => ({
        ...agent,
        unenforced: unenforcedFieldsIn(definitions, providerId, agent.disallowedTools),
      }),
  );

  /**
   * The provider behind the instance an agent names, refusing an instance
   * nobody holds and one whose provider this build does not carry. What the
   * machines hosting it can do this minute is not read: an agent is a stored
   * configuration, not a placement.
   */
  const providerOf = (instanceId: string): Effect.Effect<string, WriteError> =>
    Effect.gen(function* () {
      const found = yield* instances.one(instanceId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          validation([{ path: ["instanceId"], message: NO_SUCH_INSTANCE }]),
        );
      }
      const providerId = found.value.providerId;
      const definitions = yield* host.providers();
      if (!definitions.some((one) => one.id === providerId)) {
        return yield* Effect.fail(
          validation([
            { path: ["instanceId"], message: `this build carries no ${providerId} provider` },
          ]),
        );
      }
      return providerId;
    });

  /** Refuses a `permissionProfileId` naming no profile, before it is written as one. */
  const requireProfile = (profileId: string): Effect.Effect<void, WriteError> =>
    Effect.gen(function* () {
      const found = yield* profiles.getById(profileId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          validation([{ path: ["permissionProfileId"], message: NO_SUCH_PROFILE }]),
        );
      }
    });

  const one = (id: string): Effect.Effect<StoredAgent, NotFound | SqlError> =>
    Effect.flatMap(
      agents.one(id),
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
        const { limit, cursor, sort } = yield* Effect.mapError(decodeQuery(input), validationOf);
        const listing = yield* refuseCursor(
          agents.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
          }),
        );
        const recordOf = yield* recordReader;
        return {
          items: listing.items.map(recordOf),
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (input: Identified): Effect.Effect<Agent, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        const recordOf = yield* recordReader;
        return recordOf(yield* one(id));
      }),

    /** Records a configuration sessions can be spawned from. */
    create: (input: AgentCreateInput): Effect.Effect<Agent, WriteError> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), validationOf);
        const selection = yield* foldedSelection(decoded.model, decoded.options);
        const recordOf = yield* recordReader;
        const stored = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Inside the write set, both of them: an instance or a profile
            // read before the transaction may be deleted between the read and
            // the insert, which would file the agent on a row that is gone.
            const providerId = yield* providerOf(decoded.instanceId);
            yield* requireProfile(decoded.permissionProfileId);
            // One clock read, inside the transaction: the row and the event
            // that records it carry the same instant, so a fresh agent's
            // `updatedAt` is exactly its `createdAt`.
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
              // Ids and the name only: the log is readable by every actor
              // holding `event.read`, and an agent's prompt is its instructions.
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
        return recordOf(stored);
      }),

    /** Changes what sessions spawned from here on will run under. */
    update: (input: UpdateInput): Effect.Effect<Agent, WriteError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("agent.update");
        const { id, model, options, ...named } = yield* Effect.mapError(
          decodeUpdate(input),
          validationOf,
        );
        const selection = yield* foldedSelection(model, options);
        const edit: AgentEdit = {
          ...named,
          ...(selection === undefined ? {} : { model: selection }),
        };
        if (Object.keys(edit).length === 0) {
          return yield* Effect.fail(validation([{ path: [], message: "name a field to change" }]));
        }
        const recordOf = yield* recordReader;
        const stored = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Inside the write set: a profile or an instance deleted between
            // the check and the update would leave the agent naming a row that
            // is gone.
            if (edit.instanceId !== undefined) yield* providerOf(edit.instanceId);
            if (edit.permissionProfileId !== undefined) {
              yield* requireProfile(edit.permissionProfileId);
            }
            const at = yield* nowIso;
            // Read for its refusal: an id nobody holds is `not_found` rather
            // than an update that changed no rows and said it had.
            yield* one(id);
            yield* agents.update(id, edit, at);
            yield* audit.append({
              kind: "agent.updated",
              actor: yield* currentStamp,
              // Which fields moved, never what they moved to: the values are
              // the agent's instructions and its configuration.
              payload: { agentId: id, changed: Object.keys(edit).sort() },
              at,
            });
            return yield* one(id);
          }),
        );
        return recordOf(stored);
      }),

    /**
     * Removes an agent nothing is running under any more. A session it spawned
     * keeps the id: the session is history, and its own copy of everything the
     * agent gave it is what it runs on.
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
            const agent = yield* one(id);
            const running = yield* agents.oldestRunningSessionOf(id);
            if (Option.isSome(running)) {
              return yield* Effect.fail(
                invalidState(
                  `session ${running.value} was spawned from this agent and has not exited`,
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
