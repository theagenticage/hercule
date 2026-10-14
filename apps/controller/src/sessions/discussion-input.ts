/**
 * The Discussion Input: the Queued Input the controller writes to tell a
 * session about Discussions (spec 19 section 5).
 *
 * The row keeps what it tells the session as a structured record, the
 * Discussion mentions, and its text is built again from that record each time
 * the record changes. This module holds the record, how two records merge, and
 * the text built from one. It reads nothing and writes nothing.
 */
import * as Schema from "effect/Schema";
import { countCharacters, cutKeepingEnd, toIdTail } from "@hercule/contract";

/**
 * Everything one Discussion Input tells its session about, as its
 * `discussion_mentions` column stores it:
 *
 * - `entries`: the Discussions an Edit Overlap put the session into, each
 *   with the files it shares there. Each file names the other sessions that
 *   edited it, and whether each of them can be told (`canBeTold`, spec 19
 *   section 5.1);
 * - `newPosts`: the Discussions with Posts the session has not been told
 *   about, each with the first of those Posts.
 */
export const DiscussionMentions = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      discussionId: Schema.String,
      repository: Schema.String,
      files: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          sessions: Schema.Array(
            Schema.Struct({ sessionId: Schema.String, canBeTold: Schema.Boolean }),
          ),
        }),
      ),
    }),
  ),
  newPosts: Schema.Array(
    Schema.Struct({ discussionId: Schema.String, firstPostId: Schema.String }),
  ),
});
export type DiscussionMentions = typeof DiscussionMentions.Type;

/** A Discussion an Edit Overlap put the session into, with the files and other sessions it shares there. */
export type DiscussionEntry = DiscussionMentions["entries"][number];

/** A file the told session shares in a Discussion, with the other sessions that edited it. */
export type EntryFile = DiscussionEntry["files"][number];

/** A session an entry names beside the told session, and whether it can be told. */
export type EntrySession = EntryFile["sessions"][number];

/** A Discussion with Posts the session has not been told about, and the first of them. */
export type NewPostsMention = DiscussionMentions["newPosts"][number];

/**
 * Why a session cannot receive a Discussion Input (spec 19 section 5.1):
 *
 * - `not_running`: its status is not `queued`, `starting`, `idle` or `busy`;
 * - `done`: it is a Thread marked Done;
 * - `conversation`: it answers an assistant's conversation;
 * - `lacks_grants`: it lacks `discussion.read` or `discussion.write`.
 */
export type DiscussionInputRefusal = "not_running" | "done" | "conversation" | "lacks_grants";

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

/** A record that mentions nothing, to merge a first mention into. */
export const NO_DISCUSSION_MENTIONS: DiscussionMentions = { entries: [], newPosts: [] };

/**
 * Merges two lists into one, keyed by what `readKey` returns, and returns it
 * in the order the keys first appear: `older`'s items first, then the new
 * items of `newer`. Two items with one key are combined by
 * `combine(older, newer)`.
 */
const mergeListsByKey = <A>(
  older: ReadonlyArray<A>,
  newer: ReadonlyArray<A>,
  readKey: (item: A) => string,
  combine: (older: A, newer: A) => A,
): ReadonlyArray<A> => {
  const byKey = new Map<string, A>();
  for (const item of older) byKey.set(readKey(item), item);
  for (const item of newer) {
    const key = readKey(item);
    const found = byKey.get(key);
    byKey.set(key, found === undefined ? item : combine(found, item));
  }
  return [...byKey.values()];
};

/** Combines two entries of one Discussion: the files are joined by path, and each file's sessions by id. */
const combineEntries = (older: DiscussionEntry, newer: DiscussionEntry): DiscussionEntry => ({
  ...older,
  files: mergeListsByKey(
    older.files,
    newer.files,
    (file) => file.path,
    (olderFile, newerFile) => ({
      path: olderFile.path,
      // The newer mention knows best whether a session can be told now.
      sessions: mergeListsByKey(
        olderFile.sessions,
        newerFile.sessions,
        (session) => session.sessionId,
        (_, newerSession) => newerSession,
      ),
    }),
  ),
});

/**
 * Merges a newer mention into an older record and returns the merged record.
 * Nothing the session has not been told about is lost:
 *
 * - every entry is kept, joined by Discussion, with the files joined by path
 *   and each file's sessions joined by id;
 * - the earliest first Post of each Discussion is kept. Post ids are UUIDv7,
 *   so the smaller id is the earlier Post;
 * - a new-Posts mention of a Discussion the record has an entry for is
 *   dropped, because the entry already tells the session to read the whole
 *   Discussion. This is also why a session that joined a Discussion in the
 *   same transaction as a Post gets no new-Posts mention for it.
 */
export const mergeDiscussionMentions = (
  older: DiscussionMentions,
  newer: DiscussionMentions,
): DiscussionMentions => {
  const entries = mergeListsByKey(
    older.entries,
    newer.entries,
    (entry) => entry.discussionId,
    combineEntries,
  );
  const entered = new Set(entries.map((entry) => entry.discussionId));
  const newPosts = mergeListsByKey(
    older.newPosts,
    newer.newPosts,
    (mention) => mention.discussionId,
    (olderMention, newerMention) =>
      newerMention.firstPostId < olderMention.firstPostId ? newerMention : olderMention,
  ).filter((mention) => !entered.has(mention.discussionId));
  return { entries, newPosts };
};

/** Joins items as a person lists them: `a`, `a and b`, `a, b and c`. */
const joinAsList = (items: ReadonlyArray<string>): string =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** Builds the line that counts the Discussions the text leaves out. */
const buildMoreDiscussionsLine = (count: number, sessionId: string): string =>
  `and ${count} more discussions: run \`hercule discussion list --session ${sessionId}\`.`;

/** Builds one file's line of an entry, naming at most `MAX_SESSIONS_PER_FILE` sessions. */
const buildFileLine = (file: EntryFile): string => {
  const named = file.sessions
    .slice(0, MAX_SESSIONS_PER_FILE)
    .map(
      (session) =>
        `session ${toIdTail(session.sessionId)}${session.canBeTold ? "" : " (not told)"}`,
    );
  const left = file.sessions.length - named.length;
  const more = left > 0 ? `, and ${left} more sessions` : "";
  return `- \`${cutKeepingEnd(file.path, MAX_PATH_LENGTH)}\`, with ${named.join(", ")}${more}`;
};

/** Builds the paragraphs of one entry, listing at most `MAX_FILES_PER_ENTRY` files. */
const buildEntryText = (entry: DiscussionEntry): string => {
  const id = entry.discussionId;
  const lines = [
    `Another session edited files you edited in ${entry.repository}:`,
    ...entry.files.slice(0, MAX_FILES_PER_ENTRY).map(buildFileLine),
  ];
  const leftFiles = entry.files.length - MAX_FILES_PER_ENTRY;
  if (leftFiles > 0)
    lines.push(`and ${leftFiles} more files; see \`hercule discussion read ${id}\``);
  // Counted over every session of the entry, not only the ones named above.
  if (entry.files.every((file) => file.sessions.every((session) => !session.canBeTold))) {
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
  mentions: DiscussionMentions,
  sessionId: string,
  entryCount: number,
): string => {
  const paragraphs = mentions.entries.slice(0, entryCount).map(buildEntryText);
  const leftEntries = mentions.entries.length - entryCount;
  if (leftEntries > 0) paragraphs.push(buildMoreDiscussionsLine(leftEntries, sessionId));
  if (mentions.newPosts.length > 0)
    paragraphs.push(buildNewPostsText(mentions.newPosts, sessionId));
  return paragraphs.join("\n\n");
};

/**
 * Builds the text of the Discussion Input of session `sessionId` from its
 * record (spec 19 section 5.4): each entry as its own paragraphs, then the
 * new-Posts line. The text is bounded:
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
  mentions: DiscussionMentions,
  sessionId: string,
): string => {
  let entryCount = Math.min(mentions.entries.length, MAX_ENTRIES);
  let text = buildTextWithEntries(mentions, sessionId, entryCount);
  while (countCharacters(text) > MAX_DISCUSSION_INPUT_LENGTH && entryCount > 1) {
    entryCount -= 1;
    text = buildTextWithEntries(mentions, sessionId, entryCount);
  }
  return text;
};

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
