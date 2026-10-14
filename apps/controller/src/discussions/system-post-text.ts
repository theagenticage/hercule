/**
 * The text of an Edit Overlap system Post: what one call changed in one
 * Discussion (spec 19 section 5.5). This module builds the text from what the
 * Edit Overlap service collected, and bounds it. It reads nothing and writes
 * nothing.
 */
import { MAX_PARTICIPANTS, toIdTail } from "@hercule/contract";
import {
  describeDiscussionInputRefusal,
  type DiscussionInputRefusal,
} from "./discussion-input-text";
import { buildSessionList, quotePath } from "./text-parts";

/** The most files one system Post names. */
export const MAX_NAMED_FILES = 20;

/** The most characters of a path a system Post shows. */
export const MAX_POST_PATH_LENGTH = 120;

/** The most sessions one system Post names as not told. */
export const MAX_NAMED_NOT_TOLD = 5;

/** The most links to other Discussions one system Post names. */
export const MAX_NAMED_LINKS = 5;

/** A link to the Discussion an overlap went to instead. */
export interface OverlapLink {
  /** The session whose edit made the overlap. */
  readonly sessionId: string;
  readonly discussionId: string;
  /** The subject of the Discussion the overlap went to. */
  readonly subject: string;
}

/** What one call changed in one Discussion, which its one system Post reports. */
export interface SystemPostChanges {
  /** The files that became shared, with the sessions newly listed on each. */
  readonly files: Array<{ readonly path: string; readonly sessionIds: ReadonlyArray<string> }>;
  /** The sessions that joined and cannot receive a Discussion Input, with why. */
  readonly notTold: Map<string, DiscussionInputRefusal>;
  /** The sessions that edited a shared file but could not join, because the Discussion was full of participants. */
  readonly leftOut: Set<string>;
  /** The links to the Discussion an overlap went to instead. */
  readonly links: Array<OverlapLink>;
}

/** Builds a sentence listing the shared files, with at most `MAX_NAMED_FILES` of them. */
const buildSharedFilesLine = (files: SystemPostChanges["files"]): string => {
  const named = files
    .slice(0, MAX_NAMED_FILES)
    .map(
      (file) =>
        `${quotePath(file.path, MAX_POST_PATH_LENGTH)} (${buildSessionList(file.sessionIds)})`,
    );
  const left = files.length - named.length;
  return `Shared files: ${named.join(", ")}${left > 0 ? `, and ${left} more files` : ""}.`;
};

/** Builds one sentence per session that was not told, naming at most `MAX_NAMED_NOT_TOLD`. */
const buildNotToldLines = (notTold: SystemPostChanges["notTold"]): ReadonlyArray<string> => {
  const entries = [...notTold];
  const lines = entries
    .slice(0, MAX_NAMED_NOT_TOLD)
    .map(
      ([id, refusal]) =>
        `Session ${toIdTail(id)} was not told: ${describeDiscussionInputRefusal(refusal)}.`,
    );
  const left = entries.length - lines.length;
  return left > 0 ? [...lines, `and ${left} more sessions were not told.`] : lines;
};

/** Builds the sentence that counts the sessions the Discussion had no room for. */
const buildLeftOutLine = (count: number): string =>
  count === 1
    ? `1 more session edited these files but was left out: this discussion has ${MAX_PARTICIPANTS} participants.`
    : `${count} more sessions edited these files but were left out: this discussion has ${MAX_PARTICIPANTS} participants.`;

/** Builds the sentences for the links, naming at most `MAX_NAMED_LINKS`. */
const buildLinkLines = (links: SystemPostChanges["links"]): ReadonlyArray<string> => {
  const lines = links
    .slice(0, MAX_NAMED_LINKS)
    .map(
      (link) =>
        `Session ${toIdTail(link.sessionId)} also overlaps with sessions in discussion ` +
        `${link.discussionId} ("${link.subject}"). Continue there.`,
    );
  const left = links.length - lines.length;
  return left > 0 ? [...lines, `and ${left} more overlaps in other discussions.`] : lines;
};

/**
 * Builds the text of a Discussion's one system Post from what a call changed
 * in it: a line of shared files, a line per session not told, a line that
 * counts the sessions left out, then the links. Returns `undefined` when
 * nothing changed. The lines are separated by line breaks, so one Post holds
 * all of them.
 *
 * The text always fits `MAX_POST_LENGTH`: every list is cut, paths are cut to
 * `MAX_POST_PATH_LENGTH`, and whatever is left out is counted. The unit test
 * builds the largest text there can be and checks it.
 */
export const buildSystemPostText = (changes: SystemPostChanges): string | undefined => {
  const lines = [
    ...(changes.files.length > 0 ? [buildSharedFilesLine(changes.files)] : []),
    ...buildNotToldLines(changes.notTold),
    ...(changes.leftOut.size > 0 ? [buildLeftOutLine(changes.leftOut.size)] : []),
    ...buildLinkLines(changes.links),
  ];
  return lines.length === 0 ? undefined : lines.join("\n");
};
