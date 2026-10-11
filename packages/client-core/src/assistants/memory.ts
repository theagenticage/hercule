/**
 * The words and numbers of an assistant's memory as the settings screens show
 * it: "1,284 of 4,000" above the core note's meter, "1.2k" beside a topic,
 * and "7 of 24 topics · up to 12,000 characters each" under the list.
 */
import {
  MEMORY_CORE,
  MEMORY_TOPIC_CAP,
  MEMORY_TOPIC_COUNT_CAP,
  type MemoryDocument,
  type MemoryEntry,
  type MemoryWriteInput,
} from "@hercule/contract";
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
 * Checks whether a write failed because it would discard most of a large
 * document. The screen then offers to write it anyway, with the shrink
 * confirmed.
 */
export const isShrinkRejected = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "shrink_rejected";

/** The unsaved edits to one memory document. A field is present only while it differs from the stored one. */
export interface MemoryEdit {
  readonly gist?: string;
  readonly body?: string;
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
 * Returns `edit` with `fields` applied, keeping only the fields whose value
 * differs from the stored document. A field typed back to its stored value
 * is dropped, so another writer's later change to it shows.
 */
export const mergeMemoryEdit = (
  document: MemoryDocument,
  edit: MemoryEdit,
  fields: MemoryEdit,
): MemoryEdit => {
  const merged = { ...edit, ...fields };
  return {
    ...(merged.gist === undefined || merged.gist === document.gist ? {} : { gist: merged.gist }),
    ...(merged.body === undefined || merged.body === document.body ? {} : { body: merged.body }),
  };
};

/**
 * Builds the `memory.write` input that stores the edited document. The body
 * is always sent, because a write replaces the whole body. The gist is sent
 * only when it was edited, and never for `core`, which has none, so a save
 * never overwrites a gist another writer changed.
 */
export const buildMemoryWrite = (document: MemoryDocument, edit: MemoryEdit): MemoryWriteInput => ({
  body: edit.body ?? document.body,
  ...(edit.gist === undefined || document.name === MEMORY_CORE ? {} : { gist: edit.gist }),
});

/**
 * Returns the fields of `edit` that a save did not store: those whose value
 * differs from what was sent, such as text typed while the save ran.
 */
export const dropSavedMemoryEdit = (edit: MemoryEdit, sent: MemoryWriteInput): MemoryEdit => ({
  ...(edit.gist === undefined || edit.gist === sent.gist ? {} : { gist: edit.gist }),
  ...(edit.body === undefined || edit.body === sent.body ? {} : { body: edit.body }),
});

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

/**
 * Describes what a write the shrink guard refused would cut, from the sizes
 * the `shrink_rejected` error carries: "This cuts the document from 1,284 to
 * 312 characters. What it cuts cannot be brought back." Returns `undefined`
 * for any other error, or one without both sizes.
 */
export const describeShrinkLoss = (error: unknown): string | undefined => {
  if (!(error instanceof ApiError) || error.code !== "shrink_rejected") return undefined;
  const { details } = error;
  if (typeof details !== "object" || details === null) return undefined;
  const { previousSize, size } = details as { previousSize?: unknown; size?: unknown };
  if (typeof previousSize !== "number" || typeof size !== "number") return undefined;
  return `This cuts the document from ${formatCount(previousSize)} to ${formatCount(size)} characters. What it cuts cannot be brought back.`;
};
