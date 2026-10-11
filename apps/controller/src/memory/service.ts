/**
 * The memory operations: `memory.list`, `search`, `read`, `write`, `append`
 * and `delete`, over an assistant's `core` and its topics (spec 11 section
 * 6.4, spec 12 section 6).
 *
 * Every operation names the assistant by id or as `me`. The checks run in the
 * order the API promises, and the first that fails is the answer:
 *
 * 1. The input decodes and makes sense: `me` names an assistant, which only
 *    a session in an assistant's conversation has; a gist is not given for
 *    `core`; an append has text to add (`Validation`).
 * 2. The assistant exists (`NotFound`).
 * 3. A session reaches only its own assistant's memory (`Forbidden`).
 * 4. The document exists, for the operations that need it (`NotFound`).
 * 5. The document is still at the version the writer expects, when a write
 *    names one (`Conflict`).
 * 6. The caps and the shrink guard (`CapExceeded`, `ShrinkRejected`).
 *
 * The document is looked up only after the scope check, so a session cannot
 * learn which topics another assistant has from the answers it gets. The
 * version check comes before the caps and the shrink guard, so an editor
 * working from a stale copy learns that first: its write would be wrong even
 * if it fitted.
 *
 * Every mutation writes one audit entry in the same transaction, with the
 * assistant, the name and the size. The body is never recorded: every actor
 * that holds `event.read` can read the log, and memory holds what the user
 * told their assistant.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  chooseMemoryCap,
  countCharacters,
  createCapExceededError,
  createConflictError,
  createDecodeValidationError,
  createForbiddenError,
  createNotFoundError,
  createShrinkRejectedError,
  createValidationError,
  bounded,
  IdOrMe,
  MAX_SEARCH_TEXT_LENGTH,
  MEMORY_CORE,
  MEMORY_TOPIC_COUNT_CAP,
  MemoryDocumentName,
  MemoryWriteInput,
  OWN_AGENT_ALIAS,
  requiresShrinkConfirmation,
  type CapExceeded,
  type Conflict,
  type Forbidden,
  type Grant,
  type MemoryDocument,
  type MemoryEntry,
  type MemoryMatch,
  type NotFound,
  type ShrinkRejected,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant, type Actor } from "../actor";
import { buildMatchExpression, nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { memoryRepository } from "./repository";
import { buildSnippets } from "./snippets";

const AssistantInput = Schema.Struct({ id: IdOrMe });
const SearchInput = Schema.Struct({ id: IdOrMe, text: bounded(1, MAX_SEARCH_TEXT_LENGTH) });
const DocumentInput = Schema.Struct({ id: IdOrMe, name: MemoryDocumentName });
const WriteInput = Schema.Struct({ ...DocumentInput.fields, ...MemoryWriteInput.fields });
const AppendInput = Schema.Struct({ ...DocumentInput.fields, body: MemoryWriteInput.fields.body });

export type AssistantInput = Schema.Schema.Type<typeof AssistantInput>;
export type SearchInput = Schema.Schema.Type<typeof SearchInput>;
export type DocumentInput = Schema.Schema.Type<typeof DocumentInput>;
export type WriteInput = Schema.Schema.Type<typeof WriteInput>;
export type AppendInput = Schema.Schema.Type<typeof AppendInput>;

const decodeAssistant = Schema.decodeUnknownEffect(AssistantInput);
const decodeSearch = Schema.decodeUnknownEffect(SearchInput);
const decodeDocument = Schema.decodeUnknownEffect(DocumentInput);
const decodeWrite = Schema.decodeUnknownEffect(WriteInput);
const decodeAppend = Schema.decodeUnknownEffect(AppendInput);

/** Formats a count of characters the way the error messages show it: `12,009`. */
const formatCount = (count: number): string => count.toLocaleString("en-US");

/** Returns how a message names a document: `core`, or `topic "decisions"`. */
const describeDocument = (name: string): string =>
  name === MEMORY_CORE ? MEMORY_CORE : `topic "${name}"`;

/**
 * Returns the message for `me` from an actor that has no assistant of its
 * own, saying what to pass instead.
 */
const explainNoOwnAssistant = (actor: Actor): string => {
  switch (actor._tag) {
    case "session":
      return `"${OWN_AGENT_ALIAS}" names the assistant of this session's conversation, and this session is not part of one, so it has no memory of its own`;
    case "run":
      return `"${OWN_AGENT_ALIAS}" names a session's own assistant, and a run has none; name the assistant by its id`;
    case "user":
    case "none":
      return `"${OWN_AGENT_ALIAS}" names a session's own assistant; name the assistant by its id`;
  }
};

/**
 * Fails with `Conflict` when a write expects a version and the document is
 * not at it. `expectedVersion` 0 expects no document; `existing` is the
 * document as stored, if there is one. The message says what changed and
 * how to redo the edit.
 */
const ensureExpectedVersion = (
  name: string,
  expectedVersion: number,
  existing: Option.Option<MemoryDocument>,
): Effect.Effect<void, Conflict> => {
  const document = describeDocument(name);
  if (Option.isNone(existing)) {
    return expectedVersion === 0
      ? Effect.void
      : Effect.fail(
          createConflictError(
            `there is no ${document} (you expected version ${String(expectedVersion)}); it was probably deleted since you read it. Write without expectedVersion to create it again.`,
          ),
        );
  }
  const version = existing.value.version;
  if (version === expectedVersion) return Effect.void;
  if (expectedVersion === 0) {
    const named = name === MEMORY_CORE ? MEMORY_CORE : `a topic named "${name}"`;
    return Effect.fail(
      createConflictError(
        `${named} already exists; read it, or write without expectedVersion to replace it`,
      ),
    );
  }
  return Effect.fail(
    createConflictError(
      `${document} changed since you read it (version ${String(version)}, you expected ${String(expectedVersion)}); read it again and redo your edit`,
    ),
  );
};

/**
 * Fails with `CapExceeded` when a body of `size` characters is more than the
 * cap of the document with this name. The message names the size and the
 * cap, so the writer knows how much to cut.
 */
const ensureWithinCap = (name: string, size: number): Effect.Effect<void, CapExceeded> => {
  const cap = chooseMemoryCap(name);
  return size > cap
    ? Effect.fail(
        createCapExceededError(
          { size, cap },
          `${describeDocument(name)} is ${formatCount(size)} chars; cap is ${formatCount(cap)}. Consolidate it to fit and write it again.`,
        ),
      )
    : Effect.void;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const memory = yield* memoryRepository;
  const audit = yield* AuditLog;

  /**
   * Returns the id of the assistant whose memory an operation acts on, after
   * the checks every operation shares:
   *
   * - `me` resolves to the session's own assistant, and fails with
   *   `Validation` for any caller that has none;
   * - the assistant must exist, or the call fails with `NotFound`;
   * - a session may act only on its own assistant's memory, or the call
   *   fails with `Forbidden`, naming the operation's grant.
   *
   * Every assistant has a `core`, seeded when it is created, so the assistant
   * exists exactly when its `core` does. Reading that row keeps this domain
   * from depending on the assistants domain, which depends on it.
   */
  const resolveAssistant = (
    actor: Actor,
    id: IdOrMe,
    grant: Grant,
  ): Effect.Effect<string, Validation | NotFound | Forbidden | SqlError> =>
    Effect.gen(function* () {
      const assistantId =
        id !== OWN_AGENT_ALIAS
          ? id
          : actor._tag === "session" && actor.assistantId !== null
            ? actor.assistantId
            : yield* Effect.fail(
                createValidationError([{ path: ["id"], message: explainNoOwnAssistant(actor) }]),
              );
      const core = yield* memory.read(assistantId, MEMORY_CORE);
      if (Option.isNone(core)) return yield* Effect.fail(createNotFoundError("no such assistant"));
      if (actor._tag === "session" && actor.assistantId !== assistantId) {
        return yield* Effect.fail(
          createForbiddenError(
            grant,
            `a session reaches only its own assistant's memory; name it as "${OWN_AGENT_ALIAS}"`,
          ),
        );
      }
      return assistantId;
    });

  /** Returns a document, or fails with `NotFound` naming it and the way to see what exists. */
  const readDocumentOrFail = (
    assistantId: string,
    name: string,
  ): Effect.Effect<MemoryDocument, NotFound | SqlError> =>
    Effect.flatMap(
      memory.read(assistantId, name),
      Option.match({
        onNone: () =>
          Effect.fail(
            createNotFoundError(
              `there is no ${describeDocument(name)}; \`hercule memory list\` shows the documents there are`,
            ),
          ),
        onSome: Effect.succeed,
      }),
    );

  return {
    /** Returns the index of an assistant's memory: `core` first, then the topics by name. */
    list: (
      input: AssistantInput,
    ): Effect.Effect<ReadonlyArray<MemoryEntry>, Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("memory.list");
        const { id } = yield* Effect.mapError(decodeAssistant(input), createDecodeValidationError);
        const assistantId = yield* resolveAssistant(actor, id, "memory.read");
        return yield* memory.list(assistantId);
      }),

    /**
     * Returns the documents whose name or body matches every word of `text`,
     * best match first, each with up to three snippets around its hits. A
     * text with no word in it matches nothing.
     */
    search: (
      input: SearchInput,
    ): Effect.Effect<ReadonlyArray<MemoryMatch>, Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("memory.search");
        const { id, text } = yield* Effect.mapError(
          decodeSearch(input),
          createDecodeValidationError,
        );
        const assistantId = yield* resolveAssistant(actor, id, "memory.read");
        const match = buildMatchExpression(text);
        if (match === undefined) return [];
        const hits = yield* memory.search(assistantId, match);
        return hits.map((hit) => ({ name: hit.name, snippets: buildSnippets(hit.markedBody) }));
      }),

    /** Returns one document in full. Fails with `NotFound` when the assistant has no such document. */
    read: (
      input: DocumentInput,
    ): Effect.Effect<MemoryDocument, Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("memory.read");
        const { id, name } = yield* Effect.mapError(
          decodeDocument(input),
          createDecodeValidationError,
        );
        const assistantId = yield* resolveAssistant(actor, id, "memory.read");
        return yield* readDocumentOrFail(assistantId, name);
      }),

    /**
     * Replaces a document's body, creating the topic when it does not exist,
     * and returns the document as stored.
     *
     * The gist is set when the input has one and kept otherwise. Fails with:
     *
     * - `Validation` when a gist is given for `core`, which has none;
     * - `Conflict` when `expectedVersion` is given and the document is not
     *   at that version, or exists when it is 0;
     * - `CapExceeded` when the write would create a topic past the topic
     *   count cap, or when the body is longer than the document's cap;
     * - `ShrinkRejected` when the write would discard more than half of a
     *   document of 1,000 characters or more, unless `confirmShrink` is true.
     */
    write: (
      input: WriteInput,
    ): Effect.Effect<
      MemoryDocument,
      Forbidden | Validation | NotFound | Conflict | CapExceeded | ShrinkRejected | SqlError
    > =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("memory.write");
        const decoded = yield* Effect.mapError(decodeWrite(input), createDecodeValidationError);
        const { name, body } = decoded;
        if (name === MEMORY_CORE && decoded.gist !== undefined) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["gist"],
                message:
                  "core has no gist, because it is always given whole; leave the gist out when you write core",
              },
            ]),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const stamp = yield* currentStamp;
            const assistantId = yield* resolveAssistant(actor, decoded.id, "memory.write");
            const existing = yield* memory.read(assistantId, name);
            const size = countCharacters(body);
            if (decoded.expectedVersion !== undefined) {
              yield* ensureExpectedVersion(name, decoded.expectedVersion, existing);
            }

            if (Option.isNone(existing)) {
              // `core` always exists, so a missing document is a new topic.
              const topics = (yield* memory.list(assistantId)).length - 1;
              if (topics >= MEMORY_TOPIC_COUNT_CAP) {
                return yield* Effect.fail(
                  createCapExceededError(
                    { count: topics + 1, cap: MEMORY_TOPIC_COUNT_CAP },
                    `creating topic "${name}" would make ${String(topics + 1)} topics; cap is ${String(MEMORY_TOPIC_COUNT_CAP)}. Fold it into an existing topic, or merge or delete topics you no longer need first.`,
                  ),
                );
              }
            }
            yield* ensureWithinCap(name, size);

            if (
              Option.isSome(existing) &&
              decoded.confirmShrink !== true &&
              requiresShrinkConfirmation(existing.value.size, size)
            ) {
              const previousSize = existing.value.size;
              return yield* Effect.fail(
                createShrinkRejectedError(
                  { previousSize, size },
                  `this write would shrink ${describeDocument(name)} from ${formatCount(previousSize)} to ${formatCount(size)} chars, discarding ${formatCount(previousSize - size)} chars, more than half of it. Read it first and check that nothing you still need is lost; to write it anyway, repeat the write with confirmShrink: true (CLI: --confirm-shrink true).`,
                ),
              );
            }

            const previous = Option.getOrUndefined(existing);
            const gist = decoded.gist ?? previous?.gist ?? "";
            const document = { assistantId, name, gist, body, size, at, actor: stamp };
            yield* previous === undefined ? memory.insert(document) : memory.update(document);
            yield* audit.append({
              kind: "memory.written",
              actor: stamp,
              payload: { assistantId, name, size },
              at,
            });
            const version = previous === undefined ? 1 : previous.version + 1;
            return { name, gist, body, size, version, updatedAt: at };
          }),
        );
      }),

    /**
     * Adds text to the end of an existing document and returns the document
     * as stored. The text starts on a new line unless the body is empty or
     * already ends with one. The gist is never changed, and the shrink guard
     * does not apply, because an append removes nothing.
     *
     * Fails with:
     *
     * - `Validation` when the text is empty, since there is nothing to add;
     * - `NotFound` when the document does not exist, since only a write
     *   creates a topic;
     * - `CapExceeded` when the result would be longer than the document's cap.
     */
    append: (
      input: AppendInput,
    ): Effect.Effect<MemoryDocument, Forbidden | Validation | NotFound | CapExceeded | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("memory.append");
        const decoded = yield* Effect.mapError(decodeAppend(input), createDecodeValidationError);
        const { name } = decoded;
        if (decoded.body === "") {
          return yield* Effect.fail(
            createValidationError([
              { path: ["body"], message: "there is nothing to append; the text is empty" },
            ]),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const stamp = yield* currentStamp;
            const assistantId = yield* resolveAssistant(actor, decoded.id, "memory.write");
            const existing = yield* memory.read(assistantId, name);
            if (Option.isNone(existing)) {
              return yield* Effect.fail(
                createNotFoundError(
                  `there is no ${describeDocument(name)} to append to; create it with \`hercule memory write\``,
                ),
              );
            }
            const before = existing.value.body;
            const separator = before === "" || before.endsWith("\n") ? "" : "\n";
            const body = before + separator + decoded.body;
            const size = countCharacters(body);
            yield* ensureWithinCap(name, size);

            const gist = existing.value.gist;
            yield* memory.update({ assistantId, name, gist, body, size, at, actor: stamp });
            yield* audit.append({
              kind: "memory.appended",
              actor: stamp,
              payload: { assistantId, name, size },
              at,
            });
            return { name, gist, body, size, version: existing.value.version + 1, updatedAt: at };
          }),
        );
      }),

    /**
     * Deletes a topic. Fails with `Validation` for `core`, which every
     * session starts with and so cannot be deleted, and with `NotFound` when
     * the topic does not exist.
     */
    delete: (
      input: DocumentInput,
    ): Effect.Effect<Record<string, never>, Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("memory.delete");
        const { id, name } = yield* Effect.mapError(
          decodeDocument(input),
          createDecodeValidationError,
        );
        if (name === MEMORY_CORE) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["name"],
                message:
                  "core cannot be deleted, because every session of the assistant starts with it; to clear it, write it with an empty body",
              },
            ]),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const stamp = yield* currentStamp;
            const assistantId = yield* resolveAssistant(actor, id, "memory.write");
            const existing = yield* readDocumentOrFail(assistantId, name);
            yield* memory.delete(assistantId, name);
            yield* audit.append({
              kind: "memory.deleted",
              actor: stamp,
              payload: { assistantId, name, size: existing.size },
              at,
            });
            return {};
          }),
        );
      }),
  };
});

/** The memory operations, with the scope rule and the write-seam checks. */
export class MemoryService extends Context.Service<MemoryService, Effect.Success<typeof make>>()(
  "hercule/controller/memory/MemoryService",
) {}

export const MemoryServiceLayer = Layer.effect(MemoryService)(make);
