/**
 * The text of a Discussion Input: what the controller tells a session about
 * Discussions (spec 19 section 5.4). This module builds the text from what
 * the service read, and bounds it. It reads nothing and writes nothing.
 */
import { countCharacters, cutKeepingEnd, toIdTail } from "@hercule/contract";

/**
 * A file the told session shares in a Discussion, with the other sessions
 * that edited it, in the order they edited it.
 */
export interface EntryFile {
  readonly path: string;
  readonly sessionIds: ReadonlyArray<string>;
}

/** A Discussion an Edit Overlap put the session into, with the files it shares there. */
export interface DiscussionEntry {
  readonly discussionId: string;
  readonly repository: string;
  readonly files: ReadonlyArray<EntryFile>;
}

/** A Discussion with Posts the session has not been told about, and the first of them. */
export interface NewPostsMention {
  readonly discussionId: string;
  readonly firstPostId: string;
}

/** Everything one Discussion Input tells its session about. */
export interface DiscussionInputContent {
  /** The entries, in the order the text lists them. */
  readonly entries: ReadonlyArray<DiscussionEntry>;
  /** The Discussions with new Posts, in the order the text names them. */
  readonly newPosts: ReadonlyArray<NewPostsMention>;
  /**
   * The sessions, among the ones `listNameableSessionIds` returns, that
   * cannot receive a Discussion Input. The text marks each of them "(not
   * told)".
   */
  readonly sessionsNotTold: ReadonlySet<string>;
}

/** The text of a Discussion Input, and what it names rather than only counts. */
export interface DiscussionInputText {
  readonly text: string;
  /** The first entries of the content: the ones the text lists. */
  readonly namedEntries: ReadonlyArray<DiscussionEntry>;
  /** The first new-Posts mentions of the content: the ones the text names. */
  readonly namedNewPosts: ReadonlyArray<NewPostsMention>;
}

/** The most characters a Discussion Input's text holds (spec 19 section 5.4). */
export const MAX_DISCUSSION_INPUT_LENGTH = 8_000;

/** The most entries the text lists. */
const MAX_ENTRIES = 5;

/** The most files the text lists for one entry. */
const MAX_FILES_PER_ENTRY = 5;

/** The most sessions the text names for one file. */
const MAX_SESSIONS_PER_FILE = 5;

/** The most Discussions the new-Posts line names. */
const MAX_NEW_POSTS = 10;

/** The most characters of a path the text shows. */
const MAX_PATH_LENGTH = 200;

/** Returns the files of an entry the text can list, and the sessions it can name for each. */
const listNameableFiles = (entry: DiscussionEntry): ReadonlyArray<EntryFile> =>
  entry.files.slice(0, MAX_FILES_PER_ENTRY).map((file) => ({
    path: file.path,
    sessionIds: file.sessionIds.slice(0, MAX_SESSIONS_PER_FILE),
  }));

/**
 * Returns every session the text of these entries can name, each once. Only
 * for these sessions does the text need to know whether they can be told, so
 * the caller checks no others.
 */
export const listNameableSessionIds = (
  entries: ReadonlyArray<DiscussionEntry>,
): ReadonlyArray<string> => [
  ...new Set(
    entries
      .slice(0, MAX_ENTRIES)
      .flatMap((entry) => listNameableFiles(entry).flatMap((file) => file.sessionIds)),
  ),
];

/** Joins items as a person lists them: `a`, `a and b`, `a, b and c`. */
const joinAsList = (items: ReadonlyArray<string>): string =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** Builds the line that counts the Discussions the text leaves out. */
const buildMoreDiscussionsLine = (count: number, sessionId: string): string =>
  `and ${count} more discussions: run \`hercule discussion list --session ${sessionId}\`.`;

/** Builds one file's line of an entry, naming at most `MAX_SESSIONS_PER_FILE` sessions. */
const buildFileLine = (file: EntryFile, sessionsNotTold: ReadonlySet<string>): string => {
  const named = file.sessionIds
    .slice(0, MAX_SESSIONS_PER_FILE)
    .map((id) => `session ${toIdTail(id)}${sessionsNotTold.has(id) ? " (not told)" : ""}`);
  const left = file.sessionIds.length - named.length;
  const more = left > 0 ? `, and ${left} more sessions` : "";
  return `- \`${cutKeepingEnd(file.path, MAX_PATH_LENGTH)}\`, with ${named.join(", ")}${more}`;
};

/** Builds the paragraphs of one entry, listing at most `MAX_FILES_PER_ENTRY` files. */
const buildEntryText = (entry: DiscussionEntry, sessionsNotTold: ReadonlySet<string>): string => {
  const id = entry.discussionId;
  const lines = [
    `Another session edited files you edited in ${entry.repository}:`,
    ...entry.files
      .slice(0, MAX_FILES_PER_ENTRY)
      .map((file) => buildFileLine(file, sessionsNotTold)),
  ];
  const leftFiles = entry.files.length - MAX_FILES_PER_ENTRY;
  if (leftFiles > 0)
    lines.push(`and ${leftFiles} more files; see \`hercule discussion read ${id}\``);
  // Judged over the sessions the text names: whether the others can be told
  // is never checked, so that drafting stays bounded.
  const nameable = listNameableFiles(entry).flatMap((file) => file.sessionIds);
  if (nameable.every((sessionId) => sessionsNotTold.has(sessionId))) {
    lines.push(
      "None of them can be told now. Post your plan in the discussion; their users read it.",
    );
  }
  return (
    `${lines.join("\n")}\n\n` +
    "Nothing is blocked; this is a heads-up so you do not undo each other's work. " +
    `Read discussion ${id} with \`hercule discussion read ${id}\`, then post there who changes what: ` +
    `\`echo "<your plan>" | hercule discussion post ${id}\`.`
  );
};

/** Builds the new-Posts line, naming at most `MAX_NEW_POSTS` Discussions. */
const buildNewPostsText = (newPosts: ReadonlyArray<NewPostsMention>, sessionId: string): string => {
  const named = newPosts.slice(0, MAX_NEW_POSTS);
  const noun = named.length === 1 ? "discussion" : "discussions";
  const reads = named.map(
    (mention) =>
      `\`hercule discussion read ${mention.discussionId} --from ${mention.firstPostId}\``,
  );
  const line =
    `New posts in ${noun} ${named.map((mention) => mention.discussionId).join(", ")}. ` +
    `Read them with ${joinAsList(reads)}.`;
  const left = newPosts.length - named.length;
  return left > 0 ? `${line}\n${buildMoreDiscussionsLine(left, sessionId)}` : line;
};

/** Builds the text with the first `entryCount` entries listed and the rest counted. */
const buildTextWithEntries = (
  content: DiscussionInputContent,
  sessionId: string,
  entryCount: number,
): string => {
  const paragraphs = content.entries
    .slice(0, entryCount)
    .map((entry) => buildEntryText(entry, content.sessionsNotTold));
  const leftEntries = content.entries.length - entryCount;
  if (leftEntries > 0) paragraphs.push(buildMoreDiscussionsLine(leftEntries, sessionId));
  if (content.newPosts.length > 0) paragraphs.push(buildNewPostsText(content.newPosts, sessionId));
  return paragraphs.join("\n\n");
};

/**
 * Builds the text of the Discussion Input of session `sessionId` (spec 19
 * section 5.4): each entry as its own paragraphs, then the new-Posts line.
 * Returns the text with the entries and new-Posts mentions it names. The
 * text is bounded:
 *
 * - at most 5 entries, 5 files per entry and 5 sessions per file;
 * - at most 10 Discussions on the new-Posts line;
 * - every path cut to 200 characters, keeping its end;
 * - whatever is left out is counted, with the command that lists it.
 *
 * Five entries at their largest still exceed `MAX_DISCUSSION_INPUT_LENGTH`,
 * so entries are then left out from the end, and counted, until the text
 * fits. One entry and the new-Posts line at their largest fit with room to
 * spare, so the text always fits.
 */
export const buildDiscussionInputText = (
  content: DiscussionInputContent,
  sessionId: string,
): DiscussionInputText => {
  let entryCount = Math.min(content.entries.length, MAX_ENTRIES);
  let text = buildTextWithEntries(content, sessionId, entryCount);
  while (countCharacters(text) > MAX_DISCUSSION_INPUT_LENGTH && entryCount > 1) {
    entryCount -= 1;
    text = buildTextWithEntries(content, sessionId, entryCount);
  }
  return {
    text,
    namedEntries: content.entries.slice(0, entryCount),
    namedNewPosts: content.newPosts.slice(0, MAX_NEW_POSTS),
  };
};

/**
 * Why a session cannot receive a Discussion Input (spec 19 section 5.1):
 *
 * - `not_running`: its status is not `queued`, `starting`, `idle` or `busy`;
 * - `done`: it is a Thread marked Done;
 * - `conversation`: it answers an assistant's conversation;
 * - `lacks_grants`: it lacks `discussion.read` or `discussion.write`.
 */
export type DiscussionInputRefusal = "not_running" | "done" | "conversation" | "lacks_grants";

/**
 * Returns the reason a system Post gives for a session that was not told
 * (spec 19 section 5.5), such as "it is not running".
 */
export const describeDiscussionInputRefusal = (refusal: DiscussionInputRefusal): string => {
  switch (refusal) {
    case "not_running":
      return "it is not running";
    case "done":
      return "it is marked done";
    case "conversation":
      return "it is an assistant's conversation";
    case "lacks_grants":
      return "it lacks the discussion grants";
  }
};
