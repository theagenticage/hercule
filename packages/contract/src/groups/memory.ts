/**
 * Memory: an assistant's durable notes, held by the controller and reached
 * only through these operations ([ADR 0020]).
 *
 * An assistant has one `core` document, seeded when the assistant is created
 * and injected in full at the start of every session, and up to 24 topics,
 * of which only the index (name, size and gist) is injected. The caps and the
 * shrink guard below are enforced by the controller at the write seam, and
 * the clients read the same constants to show how close a document is to its
 * cap ([12-assistants section 6]).
 *
 * The assistant id in every path may be `me`: a session token resolves it to
 * the session's own assistant, and is refused any other assistant's memory.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  CapExceeded,
  Conflict,
  Forbidden,
  Internal,
  NotFound,
  ShrinkRejected,
  Unauthenticated,
  Validation,
} from "../errors";
import { IdOrMe, Timestamp } from "../ids";
import { Authenticated } from "../security";
import { bounded } from "../strings";
import { MAX_SEARCH_TEXT_LENGTH } from "./task";

/** The name of the document every assistant has, which can be cleared but not deleted. */
export const MEMORY_CORE = "core";

/** The most characters `core` may hold. */
export const MEMORY_CORE_CAP = 4_000;

/** The most characters one topic may hold. */
export const MEMORY_TOPIC_CAP = 12_000;

/** The most topics one assistant may have. `core` is not a topic. */
export const MEMORY_TOPIC_COUNT_CAP = 24;

/** The smallest document the shrink guard protects, in characters. */
export const SHRINK_GUARD_MIN_SIZE = 1_000;

/**
 * The longest text one write or append may carry. It is far above both caps
 * on purpose: an over-cap write must reach the controller, which refuses it
 * with `cap_exceeded` naming its size, so the writer learns how much to cut.
 */
export const MAX_MEMORY_WRITE_LENGTH = 64 * 1024;

/** The longest topic name. */
export const MAX_MEMORY_NAME_LENGTH = 64;

/** The longest gist. A gist is one line in an index, not a summary. */
export const MAX_MEMORY_GIST_LENGTH = 200;

/** Returns the cap, in characters, of the document with this name. */
export const chooseMemoryCap = (name: string): number =>
  name === MEMORY_CORE ? MEMORY_CORE_CAP : MEMORY_TOPIC_CAP;

/**
 * Checks whether a write that takes a document from `previousSize` to `size`
 * characters needs its shrink confirmed: the document holds 1,000 characters
 * or more and the write would remove more than half of them.
 */
export const requiresShrinkConfirmation = (previousSize: number, size: number): boolean =>
  previousSize >= SHRINK_GUARD_MIN_SIZE && size * 2 < previousSize;

// A topic name is a path segment, so it cannot contain a slash, and the
// segments `.` and `..` would be rewritten by every URL parser on the way.
// `search` is the path of the search operation, so a topic with that name
// could never be read.
const RESERVED_NAMES = new Set([".", "..", "search"]);

/**
 * The name of a memory document: `core`, or a topic's name. A topic name is
 * free-form text on one line, with no slash and no space at either end.
 */
export const MemoryDocumentName = bounded(1, MAX_MEMORY_NAME_LENGTH).check(
  Schema.makeFilter((name: string) => {
    if (RESERVED_NAMES.has(name)) return `"${name}" is reserved; choose another name`;
    if (name.includes("/")) return "a memory name cannot contain a slash";
    // eslint-disable-next-line no-control-regex -- control characters are what this refuses
    if (/[\u0000-\u001f\u007f]/.test(name)) return "a memory name must be one line of text";
    if (name.trim() !== name) return "a memory name cannot start or end with a space";
    return undefined;
  }),
);

/** A topic's one-line summary, shown in the index. Empty is allowed. */
export const MemoryGist = Schema.String.check(
  Schema.isMaxLength(MAX_MEMORY_GIST_LENGTH),
  Schema.makeFilter((gist: string) =>
    /[\r\n]/.test(gist) ? "a gist is one line; put the detail in the body" : undefined,
  ),
);

/**
 * The text a write or append carries. Control characters other than tab and
 * line breaks are refused: memory is text, and search marks its hits with
 * control characters.
 */
export const MemoryText = Schema.String.check(
  Schema.isMaxLength(MAX_MEMORY_WRITE_LENGTH),
  Schema.makeFilter((text: string) =>
    // eslint-disable-next-line no-control-regex -- control characters are what this refuses
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
      ? "memory text cannot contain control characters other than tab and line breaks"
      : undefined,
  ),
);

/**
 * One entry of the index: what an assistant sees about a document without
 * reading it. `size` counts the body's characters. `core` has an empty gist.
 */
export const MemoryEntry = Schema.Struct({
  name: Schema.String,
  gist: Schema.String,
  size: Schema.Int,
});

export type MemoryEntry = Schema.Schema.Type<typeof MemoryEntry>;

/**
 * A version number of a memory document. A document is at version 1 when it
 * is created and each write or append adds one; a document that does not
 * exist is at version 0.
 */
export const MemoryVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A whole document. */
export const MemoryDocument = Schema.Struct({
  ...MemoryEntry.fields,
  body: Schema.String,
  version: MemoryVersion,
  updatedAt: Timestamp,
});

export type MemoryDocument = Schema.Schema.Type<typeof MemoryDocument>;

/** A document that matches a search, with a short window of text around each hit. */
export const MemoryMatch = Schema.Struct({
  name: Schema.String,
  snippets: Schema.Array(Schema.String),
});

export type MemoryMatch = Schema.Schema.Type<typeof MemoryMatch>;

/** The input of `memory.write`. */
export const MemoryWriteInput = Schema.Struct({
  body: MemoryText,
  /** Sets a topic's gist. Unchanged when absent; refused for `core`, which has none. */
  gist: Schema.optionalKey(MemoryGist),
  /** Confirms a write the shrink guard would refuse. */
  confirmShrink: Schema.optionalKey(Schema.Boolean),
  /**
   * Refuses the write with `conflict` unless the document is still at this
   * version; `0` refuses it unless the document does not exist yet. An editor
   * sends the version it read, so it never replaces text written since.
   */
  expectedVersion: Schema.optionalKey(MemoryVersion),
});

export type MemoryWriteInput = Schema.Schema.Type<typeof MemoryWriteInput>;

const AssistantPath = { id: IdOrMe };
const DocumentPath = { id: IdOrMe, name: MemoryDocumentName };

export const memory = HttpApiGroup.make("memory")
  .add(
    HttpApiEndpoint.get("list", "/assistants/:id/memory", {
      params: AssistantPath,
      success: Schema.Array(MemoryEntry),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.get("search", "/assistants/:id/memory/search", {
      params: AssistantPath,
      query: Schema.Struct({ text: bounded(1, MAX_SEARCH_TEXT_LENGTH) }),
      success: Schema.Array(MemoryMatch),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.get("read", "/assistants/:id/memory/:name", {
      params: DocumentPath,
      success: MemoryDocument,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.put("write", "/assistants/:id/memory/:name", {
      params: DocumentPath,
      payload: MemoryWriteInput,
      success: MemoryDocument,
      error: [
        Unauthenticated,
        Forbidden,
        Validation,
        NotFound,
        Conflict,
        CapExceeded,
        ShrinkRejected,
        Internal,
      ],
    }),
    HttpApiEndpoint.post("append", "/assistants/:id/memory/:name/append", {
      params: DocumentPath,
      payload: Schema.Struct({ body: MemoryText }),
      success: MemoryDocument,
      error: [Unauthenticated, Forbidden, Validation, NotFound, CapExceeded, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/assistants/:id/memory/:name", {
      params: DocumentPath,
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
