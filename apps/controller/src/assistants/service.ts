/**
 * The assistant operations: `assistant.query`, `read`, `create`, `update` and
 * `delete`. The conversation messages an assistant's sessions write are
 * written by `AssistantSessionObserverLayer`.
 *
 * An assistant is an agent the user talks to through a conversation. It is stored as two rows that
 * share one id: an agent row of kind `assistant`, written through the agents
 * domain, and a row in the `assistants` table with the heartbeat, the
 * rotation and the reply mode. Every write here changes both rows in one
 * transaction, so they cannot drift apart.
 *
 * A create needs only a name. Every other field takes a default from
 * `defaults.ts`, except two that depend on what this controller holds: the
 * provider instance is the oldest one whose provider this build carries, and
 * the permission profile is the shipped `assistant` profile.
 *
 * Every assistant gets its web conversation in the transaction that creates
 * it, so the web app has a conversation to open from the start.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  ASSISTANT_SORT_FIELDS,
  AssistantCreateInput,
  AssistantUpdateInput,
  DEFAULT_PAGE_LIMIT,
  Id,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  type Assistant,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import {
  buildAgentFieldChecks,
  agentRepository,
  buildModelSelection,
  type StoredAgent,
} from "../agents";
import { ConversationService } from "../conversations";
import { announce, buildPageInputFields, nowIso, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PermissionProfiles, type GrantsError } from "../permissions";
import { PluginHost } from "../plugins";
import { providerRepository } from "../providers";
import { SessionService, sessionRepository } from "../sessions";
import {
  DEFAULT_ACCESS_MODE,
  DEFAULT_DISALLOWED_TOOLS,
  DEFAULT_HEARTBEAT,
  DEFAULT_PROFILE_NAME,
  DEFAULT_REPLY,
  DEFAULT_ROTATION,
  DEFAULT_SYSTEM_PROMPT,
} from "./defaults";
import {
  assistantRepository,
  type AssistantFieldsEdit,
  type StoredAssistantFields,
} from "./repository";
import { AssistantSessions } from "./sessions";

const QueryInput = Schema.Struct(buildPageInputFields(ASSISTANT_SORT_FIELDS));

export type AssistantQueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...AssistantUpdateInput.fields });

export type AssistantUpdateRequest = Schema.Schema.Type<typeof UpdateInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(AssistantCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);

export interface AssistantPage {
  readonly items: ReadonlyArray<Assistant>;
  readonly nextCursor?: string;
}

/** Oldest first: the first assistant, made at setup, leads the list. */
const DEFAULT_DIRECTION: SortDirection = "asc";

const NO_SUCH_ASSISTANT = "no such assistant";

/** Why the queued inputs of a deleted assistant's sessions were cancelled. */
const ASSISTANT_DELETED = "the assistant was deleted";

/**
 * The errors every operation can fail with. `SchemaError` comes from the
 * provider catalog, which every operation reads to report `unenforced`.
 */
type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

type WriteError = ReadError | Validation | GrantsError;

/** Builds the API record from the two rows of one assistant. */
const composeAssistant = (
  composeAgent: (stored: StoredAgent) => Omit<Assistant, "heartbeat" | "rotation" | "reply">,
  agent: StoredAgent,
  fields: StoredAssistantFields,
): Assistant => ({
  ...composeAgent(agent),
  heartbeat: fields.heartbeat,
  rotation: fields.rotation,
  reply: fields.reply,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const agents = yield* agentRepository;
  const assistants = yield* assistantRepository;
  const instances = yield* providerRepository;
  const host = yield* PluginHost;
  const profiles = yield* PermissionProfiles;
  const conversations = yield* ConversationService;
  const audit = yield* AuditLog;
  const sessions = yield* AssistantSessions;
  const sessionService = yield* SessionService;
  const sessionRows = yield* sessionRepository;
  const { buildAgentRecordComposer, readProviderIdOrFail, validateProfileExists } =
    yield* buildAgentFieldChecks;

  /**
   * Returns both rows of an assistant. Fails with `NotFound` if the id has no
   * agent row or no assistant row, which is the case for a plain agent's id.
   */
  const readAssistantOrFail = (
    id: string,
  ): Effect.Effect<
    { readonly agent: StoredAgent; readonly fields: StoredAssistantFields },
    NotFound | SqlError
  > =>
    Effect.gen(function* () {
      const agent = yield* agents.read(id);
      const fields = yield* assistants.read(id);
      if (Option.isNone(agent) || Option.isNone(fields)) {
        return yield* Effect.fail(createNotFoundError(NO_SUCH_ASSISTANT));
      }
      return { agent: agent.value, fields: fields.value };
    });

  /**
   * Returns the oldest provider instance whose provider this build carries,
   * the one an assistant uses when its create names none. An instance of a
   * provider the build no longer carries is skipped, because no session could
   * start on it. Fails with `InvalidState` when there is none: the user can
   * reach that by deleting every instance.
   */
  const readDefaultInstanceOrFail: Effect.Effect<
    { readonly id: string; readonly providerId: string },
    InvalidState | SqlError | Schema.SchemaError
  > = Effect.gen(function* () {
    const carried = new Set((yield* host.providers()).map((definition) => definition.id));
    const [oldest] = (yield* instances.list())
      .filter((instance) => carried.has(instance.providerId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (oldest === undefined) {
      return yield* Effect.fail(
        createInvalidStateError(
          "there is no provider instance to run the assistant on; " +
            "add a provider instance first, then try again",
        ),
      );
    }
    return { id: oldest.id, providerId: oldest.providerId };
  });

  /** Records a change to the assistant, so every client showing it reads it again. */
  const nudge = (id: string, kind: "created" | "updated" | "deleted"): Effect.Effect<void> =>
    announce({ _tag: "record", topic: "assistant", id, kind });

  /**
   * Returns the id of the shipped `assistant` permission profile. A shipped
   * profile has no identity beyond its name and its `shipped` flag, so both
   * are checked: a profile the user made and named `assistant` is never
   * picked. Fails with `InvalidState` when there is no such profile, which
   * happens when the user renames the shipped one: the controller seeds it
   * again only at its next start.
   */
  const readDefaultProfileIdOrFail: Effect.Effect<string, InvalidState | GrantsError | SqlError> =
    Effect.flatMap(profiles.getByName(DEFAULT_PROFILE_NAME), (found) =>
      Option.isSome(found) && found.value.shipped
        ? Effect.succeed(found.value.id)
        : Effect.fail(
            createInvalidStateError(
              `the shipped permission profile ${DEFAULT_PROFILE_NAME} was renamed, ` +
                "so there is no default profile for the assistant; " +
                "name a profile with permissionProfileId, or restart the controller to seed the shipped one again",
            ),
          ),
    );

  return {
    /** Returns one page of the assistants, oldest first by default. */
    query: (input: AssistantQueryInput): Effect.Effect<AssistantPage, ReadError | Validation> =>
      Effect.gen(function* () {
        yield* requireGrant("assistant.query");
        const { limit, cursor, sort } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const listing = yield* refuseCursor(
          assistants.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
          }),
        );
        const byId = new Map(
          (yield* agents.readMany(listing.items.map((fields) => fields.agentId))).map((agent) => [
            agent.id,
            agent,
          ]),
        );
        const composeAgent = yield* buildAgentRecordComposer;
        return {
          // Both rows are written in one transaction, so every assistant row
          // has its agent row.
          items: listing.items.map((fields) =>
            composeAssistant(composeAgent, byId.get(fields.agentId)!, fields),
          ),
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /** Returns the assistant with this id. Fails with `NotFound` when there is none. */
    read: (id: Id): Effect.Effect<Assistant, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("assistant.read");
        const { agent, fields } = yield* readAssistantOrFail(id);
        return composeAssistant(yield* buildAgentRecordComposer, agent, fields);
      }),

    /**
     * Creates an assistant and its web conversation, and returns the
     * assistant. Fails with:
     *
     * - `Validation` if a named instance or profile does not exist;
     * - `InvalidState` if no instance or profile is named and there is none
     *   to default to.
     */
    create: (input: AssistantCreateInput): Effect.Effect<Assistant, WriteError | InvalidState> =>
      Effect.gen(function* () {
        yield* requireGrant("assistant.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const selection = yield* buildModelSelection(decoded.model, decoded.options);
        const composeAgent = yield* buildAgentRecordComposer;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Every read is inside the write set, so an instance or a profile
            // cannot be deleted between its check and the insert.
            const instance =
              decoded.instanceId === undefined
                ? yield* readDefaultInstanceOrFail
                : {
                    id: decoded.instanceId,
                    providerId: yield* readProviderIdOrFail(decoded.instanceId),
                  };
            const permissionProfileId =
              decoded.permissionProfileId === undefined
                ? yield* readDefaultProfileIdOrFail
                : yield* Effect.as(
                    validateProfileExists(decoded.permissionProfileId),
                    decoded.permissionProfileId,
                  );
            const at = yield* nowIso;
            const agent = yield* agents.insert({
              kind: "assistant",
              providerId: instance.providerId,
              name: decoded.name,
              systemPrompt: decoded.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
              instanceId: instance.id,
              permissionProfileId,
              accessMode: decoded.accessMode ?? DEFAULT_ACCESS_MODE,
              model: selection ?? null,
              disallowedTools: decoded.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS,
              at,
            });
            const fields = yield* assistants.insert({
              agentId: agent.id,
              heartbeat: decoded.heartbeat ?? DEFAULT_HEARTBEAT,
              rotation: decoded.rotation ?? DEFAULT_ROTATION,
              reply: decoded.reply ?? DEFAULT_REPLY,
              at,
            });
            yield* conversations.create({
              assistantId: agent.id,
              channel: "web",
              containerKey: null,
            });
            yield* nudge(agent.id, "created");
            yield* audit.append({
              kind: "assistant.created",
              actor: yield* currentStamp,
              // Ids and the name only. Every actor that holds `event.read`
              // can read the log, and an assistant's prompt is its instructions.
              payload: {
                agentId: agent.id,
                name: agent.name,
                instanceId: instance.id,
                permissionProfileId,
              },
              at,
            });
            return composeAssistant(composeAgent, agent, fields);
          }),
        );
      }),

    /**
     * Updates an assistant and returns it. Fails with `Validation` if no
     * field is set or a named instance or profile does not exist, and with
     * `NotFound` if the assistant does not exist.
     */
    update: (input: AssistantUpdateRequest): Effect.Effect<Assistant, WriteError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("assistant.update");
        const { id, model, options, heartbeat, rotation, reply, ...named } = yield* Effect.mapError(
          decodeUpdate(input),
          createDecodeValidationError,
        );
        const selection = yield* buildModelSelection(model, options);
        const agentEdit = { ...named, ...(selection === undefined ? {} : { model: selection }) };
        const fieldsEdit: AssistantFieldsEdit = {
          ...(heartbeat === undefined ? {} : { heartbeat }),
          ...(rotation === undefined ? {} : { rotation }),
          ...(reply === undefined ? {} : { reply }),
        };
        const changed = [...Object.keys(agentEdit), ...Object.keys(fieldsEdit)].sort();
        if (changed.length === 0) {
          return yield* Effect.fail(
            createValidationError([{ path: [], message: "name a field to change" }]),
          );
        }
        const composeAgent = yield* buildAgentRecordComposer;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Read first, so that an unknown id fails with `not_found` before
            // its fields are checked, instead of an update that changes no
            // rows and reports success.
            yield* readAssistantOrFail(id);
            if (agentEdit.instanceId !== undefined) {
              yield* readProviderIdOrFail(agentEdit.instanceId);
            }
            if (agentEdit.permissionProfileId !== undefined) {
              yield* validateProfileExists(agentEdit.permissionProfileId);
            }
            const at = yield* nowIso;
            // The agent row is written even when only assistant fields
            // change, because the assistant's `updatedAt` is the agent row's.
            yield* agents.update(id, agentEdit, at);
            if (Object.keys(fieldsEdit).length > 0) yield* assistants.update(id, fieldsEdit);
            yield* nudge(id, "updated");
            yield* audit.append({
              kind: "assistant.updated",
              actor: yield* currentStamp,
              // Which fields changed, never their new values. The values are
              // the assistant's instructions and its configuration.
              payload: { agentId: id, changed },
              at,
            });
            const { agent, fields } = yield* readAssistantOrFail(id);
            return composeAssistant(composeAgent, agent, fields);
          }),
        );
      }),

    /**
     * Deletes an assistant, its agent row, its conversations and their
     * messages, in one transaction, and cancels any input still waiting on
     * its sessions. Its sessions and their transcripts stay, as history.
     *
     * Every session of its conversations that has not exited is stopped
     * once the transaction commits, and the delete does not wait for the
     * sessions to exit. That is usually only the newest session, but an older
     * one can still be running, for example while an earlier stop is under
     * way. A report that arrives from one of those sessions afterwards
     * writes nothing, because its conversation is gone. Fails with
     * `NotFound` if the assistant does not exist.
     */
    delete: (id: Id): Effect.Effect<Record<string, never>, WriteError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("assistant.delete");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const { agent } = yield* readAssistantOrFail(id);
            for (const conversation of yield* conversations.listForAssistant(id)) {
              for (const session of yield* sessionRows.listLiveInConversation(conversation.id)) {
                yield* sessions.stop(session.id);
              }
              // An exited session can still hold input, such as a message
              // waiting for a session that was unloaded while idle. Left
              // waiting, it would resume the session after the assistant is
              // gone. Its workspace is also kept for the idle window, which
              // no longer applies once nothing can resume it.
              yield* sessionService.abandonConversation(conversation.id, ASSISTANT_DELETED);
              yield* conversations.delete(conversation.id);
            }
            yield* assistants.delete(id);
            yield* agents.delete(id);
            const at = yield* nowIso;
            yield* nudge(id, "deleted");
            yield* audit.append({
              kind: "assistant.deleted",
              actor: yield* currentStamp,
              payload: { agentId: id, name: agent.name },
              at,
            });
            return {};
          }),
        );
      }),
  };
});

/** The assistant service. */
export class AssistantService extends Context.Service<
  AssistantService,
  Effect.Success<typeof make>
>()("hercule/controller/assistants/AssistantService") {}

export const AssistantServiceLayer: Layer.Layer<
  AssistantService,
  never,
  | SqlClient.SqlClient
  | AuditLog
  | PermissionProfiles
  | PluginHost
  | ConversationService
  | SessionService
  | AssistantSessions
> = Layer.effect(AssistantService)(make);
