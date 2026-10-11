/**
 * The words and numbers of an assistant's memory as the settings screens show
 * it: "1,284 of 4,000" above the core note's meter, "1.2k" beside a topic,
 * and "7 of 24 topics · up to 12,000 characters each" under the list.
 */
import {
  MEMORY_CORE,
  MEMORY_TOPIC_CAP,
  MEMORY_TOPIC_COUNT_CAP,
  ShrinkDetails,
  type MemoryDocument,
  type MemoryEntry,
  type MemoryWriteInput,
} from "@hercule/contract";
import { Schema } from "effect";
import { ApiError } from "../errors";

const formatCount = (count: number): string => count.toLocaleString("en-US");

/** Formats how full a document is: 1284 characters of a 4000 cap is "1,284 of 4,000". */
export const formatMemoryUsage = (size: number, cap: number): string =>
  `${formatCount(size)} of ${formatCount(cap)}`;

/**
 * Returns how full a document is as a share between 0 and 1, for a meter. A
 * document over its cap, which only a cap lowered later could leave, shows
 * as full.
 */
export const computeMemoryFill = (size: number, cap: number): number => Math.min(size / cap, 1);

/**
 * Formats a topic's size the way the topic list shows it: below 1,000
 * characters the exact count ("131"), above it thousands with one decimal
 * ("1.2k"), so a short topic never reads as "0.0k".
 */
export const formatMemorySize = (size: number): string =>
  size < 1000 ? String(size) : `${(size / 1000).toFixed(1)}k`;

/** Describes how many topics there are, against their caps: "7 of 24 topics · up to 12,000 characters each". */
export const describeTopicCount = (count: number): string =>
  `${String(count)} of ${String(MEMORY_TOPIC_COUNT_CAP)} topics · up to ${formatCount(MEMORY_TOPIC_CAP)} characters each`;

/**
 * Describes how assistants see their topics, for the screens that create and
 * edit one: "Ada sees each topic's name, size and gist at the start of every
 * session, and reads its text when it needs it."
 */
export const describeTopicVisibility = (assistantName: string): string =>
  `${assistantName} sees each topic’s name, size and gist at the start of every session, and reads its text when it needs it.`;

/**
 * The unsaved edits to one memory document. A text field is present only
 * while it differs from the stored one, and `baseVersion` is present only
 * while a text field is.
 */
export interface MemoryEdit {
  readonly gist?: string;
  readonly body?: string;
  /**
   * The version of the document the edit was made against. A save sends it
   * as `expectedVersion`, so it fails with `conflict` instead of replacing
   * text another writer stored after the edit began. It is kept apart from
   * the document because a screen may read the document again while the
   * edit is open, and the newer version must not make the save succeed.
   */
  readonly baseVersion?: number;
}

/** A topic the user is writing that is not stored yet. */
export interface NewTopicDraft {
  readonly name: string;
  readonly gist: string;
  readonly body: string;
}

/**
 * Every unsaved edit to one assistant's memory: the edits to stored
 * documents, keyed by document name, and the new topic being written, or
 * `null` when none is open.
 */
export interface MemoryEdits {
  readonly documents: Readonly<Record<string, MemoryEdit>>;
  readonly newTopic: NewTopicDraft | null;
}

/** The memory edits of an assistant nobody has edited. */
export const NO_MEMORY_EDITS: MemoryEdits = { documents: {}, newTopic: null };

/** Returns the index entries of the topics, in the listed order, without `core`. */
export const listMemoryTopics = (entries: readonly MemoryEntry[]): readonly MemoryEntry[] =>
  entries.filter((entry) => entry.name !== MEMORY_CORE);

/**
 * Checks whether the memory edits hold anything a user would lose: an edited
 * document, or a new topic with any text typed into it. A new topic opened
 * and left empty holds nothing.
 */
export const hasUnsavedMemoryEdits = (edits: MemoryEdits): boolean =>
  Object.keys(edits.documents).length > 0 ||
  (edits.newTopic !== null &&
    (edits.newTopic.name !== "" || edits.newTopic.gist !== "" || edits.newTopic.body !== ""));

/**
 * Returns `edit` with its `baseVersion` set to `version`, or no edit at all
 * when no text field is left.
 */
const stampMemoryEdit = (fields: Pick<MemoryEdit, "gist" | "body">, version: number): MemoryEdit =>
  fields.gist === undefined && fields.body === undefined ? {} : { ...fields, baseVersion: version };

/**
 * Returns `edit` with the text fields of `fields` applied. An edit that
 * starts here is based on the version of `document`; one already open keeps
 * its `baseVersion`.
 *
 * - With no save of the document running, a field typed back to its stored
 *   value is dropped, so another writer's later change to it shows.
 * - While a save runs (`saving`), no field is dropped. The stored value is
 *   about to change, so a field equal to it may be the user taking the
 *   saved text back; `dropSavedMemoryEdit` settles it once the save is
 *   stored. After a save fails, call this again with no fields to drop
 *   what equals the stored document.
 */
export const mergeMemoryEdit = (
  document: MemoryDocument,
  edit: MemoryEdit,
  fields: Pick<MemoryEdit, "gist" | "body">,
  saving: boolean,
): MemoryEdit => {
  const gist = fields.gist ?? edit.gist;
  const body = fields.body ?? edit.body;
  return stampMemoryEdit(
    {
      ...(gist === undefined || (!saving && gist === document.gist) ? {} : { gist }),
      ...(body === undefined || (!saving && body === document.body) ? {} : { body }),
    },
    edit.baseVersion ?? document.version,
  );
};

/**
 * Where the user began editing one field of a memory document: the text the
 * field showed when typing began, and the version of the document then.
 */
export interface MemoryFieldEditStart {
  readonly field: "gist" | "body";
  readonly shown: string;
  readonly version: number;
}

/**
 * Returns the version a save of one field, begun at `start`, is made against,
 * given `cached`, the document as it is cached when the save runs. A save
 * sends it as `expectedVersion`.
 *
 * - When the cached field still holds the text it showed when typing began,
 *   nobody changed that field since, so the save is made against `cached`.
 *   The user's own saves stored in between move the version on this way,
 *   and a write to another field is kept, because the save sends the cached
 *   value of every field it does not edit.
 * - Otherwise the save is made against `start.version`, and the controller
 *   refuses it when anyone wrote the document since. A read that brings
 *   another writer's text never moves the version on, so the save cannot
 *   replace text the user did not see.
 */
export const chooseMemoryBaseVersion = (
  cached: MemoryDocument,
  start: MemoryFieldEditStart,
): number => (cached[start.field] === start.shown ? cached.version : start.version);

/**
 * Builds the `memory.write` input that stores the edited document.
 *
 * - The body is always sent, because a write replaces the whole body.
 * - The gist is sent only when it was edited, and never for `core`, which
 *   has none, so a save never overwrites a gist another writer changed.
 * - `expectedVersion` is the version the edit was made against, or the
 *   version of `document` for an edit that does not carry one, so the
 *   controller refuses the write if another writer stored text since.
 */
export const buildMemoryWrite = (document: MemoryDocument, edit: MemoryEdit): MemoryWriteInput => ({
  body: edit.body ?? document.body,
  ...(edit.gist === undefined || document.name === MEMORY_CORE ? {} : { gist: edit.gist }),
  expectedVersion: edit.baseVersion ?? document.version,
});

/**
 * Returns the fields of `edit` that a save did not store: those whose value
 * differs from what was `sent`, such as text typed while the save ran. What
 * is left is based on `saved`, the document the save stored.
 */
export const dropSavedMemoryEdit = (
  edit: MemoryEdit,
  sent: MemoryWriteInput,
  saved: MemoryDocument,
): MemoryEdit =>
  stampMemoryEdit(
    {
      ...(edit.gist === undefined || edit.gist === sent.gist ? {} : { gist: edit.gist }),
      ...(edit.body === undefined || edit.body === sent.body ? {} : { body: edit.body }),
    },
    saved.version,
  );

/**
 * Returns `edit` based on the version of `document`, so its next save
 * replaces that version. A screen calls it when the user chooses to save
 * their text over a document that changed since they began editing.
 */
export const rebaseMemoryEdit = (edit: MemoryEdit, document: MemoryDocument): MemoryEdit =>
  stampMemoryEdit(
    {
      ...(edit.gist === undefined ? {} : { gist: edit.gist }),
      ...(edit.body === undefined ? {} : { body: edit.body }),
    },
    document.version,
  );

/**
 * Returns `edits` with the edit of the document `name` replaced by `edit`.
 * An edit with no text field left is removed, so an untouched document
 * never counts as unsaved.
 */
export const replaceDocumentEdit = (
  edits: MemoryEdits,
  name: string,
  edit: MemoryEdit,
): MemoryEdits => {
  const documents = { ...edits.documents, [name]: edit };
  if (edit.gist === undefined && edit.body === undefined) delete documents[name];
  return { ...edits, documents };
};

/**
 * Returns the memory index with the entry of `saved` updated to its new gist
 * and size, for a screen that caches the index after a save.
 */
export const updateMemoryEntry = (
  entries: readonly MemoryEntry[],
  saved: MemoryDocument,
): readonly MemoryEntry[] =>
  entries.map((entry) =>
    entry.name === saved.name ? { name: saved.name, gist: saved.gist, size: saved.size } : entry,
  );

/** Returns the memory index without the document `name`, for a screen that caches it after a delete. */
export const removeMemoryEntry = (
  entries: readonly MemoryEntry[],
  name: string,
): readonly MemoryEntry[] => entries.filter((entry) => entry.name !== name);

/**
 * Describes why a new topic cannot take `name`, or returns `undefined` when
 * it can. A write to an existing name replaces that document, so a new topic
 * named like one would overwrite it without a word.
 */
export const describeTopicNameConflict = (
  entries: readonly MemoryEntry[],
  name: string,
): string | undefined => {
  if (name === MEMORY_CORE) return `"${MEMORY_CORE}" is the core note; choose another name.`;
  return entries.some((entry) => entry.name === name)
    ? `A topic named "${name}" already exists; open it to edit it.`
    : undefined;
};

const isShrinkDetails = Schema.is(ShrinkDetails);

/**
 * Describes what a write the shrink guard refused would cut, from the sizes
 * the `shrink_rejected` error carries: "This cuts the document from 1,284 to
 * 312 characters. What it cuts cannot be brought back."
 *
 * Returns `undefined` for any other error, so a screen uses it as its one
 * check for a refused shrink, which it then offers to write anyway. The
 * contract requires both sizes on every `shrink_rejected` response; one
 * without them is not a response the controller sends, and is treated as any
 * other error.
 */
export const describeShrinkLoss = (error: unknown): string | undefined => {
  if (!(error instanceof ApiError) || error.code !== "shrink_rejected") return undefined;
  if (!isShrinkDetails(error.details)) return undefined;
  const { previousSize, size } = error.details;
  return `This cuts the document from ${formatCount(previousSize)} to ${formatCount(size)} characters. What it cuts cannot be brought back.`;
};
