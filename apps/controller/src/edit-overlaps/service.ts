/**
 * The Edit Overlap operations (spec 19 section 4): recording the files a
 * session edited, and putting the sessions that edited the same file into one
 * overlap Discussion.
 *
 * Both methods only read and write rows, in the caller's transaction, and
 * never wait on a runner. They return the sessions that gained a pending
 * entry, so the caller can tell them after the transaction commits (spec 19
 * section 6). The Discussions are written through the Discussion service's
 * internal methods, which stamp every change as `system`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { cutKeepingEnd, MAX_PARTICIPANTS, toIdTail } from "@hercule/contract";
import type { EditedFile } from "@hercule/protocol";
import { nowIso } from "../db";
import {
  DiscussionService,
  describeDiscussionInputRefusal,
  MAX_PATH_LENGTH,
  type DiscussionInputRefusal,
  type OverlapFile,
} from "../discussions";
import { resourceRepository } from "../resources";
import { listCheckedOutRepositories } from "../workspaces";
import { editOverlapRepository } from "./repository";

/** The most files one system Post names. */
const MAX_NAMED_FILES = 20;

/** The most sessions one system Post names for a file. */
const MAX_NAMED_SESSIONS_PER_FILE = 5;

/** The most sessions one system Post names as not told. */
const MAX_NAMED_NOT_TOLD = 5;

/** The most links to other Discussions one system Post names. */
const MAX_NAMED_LINKS = 5;

/** What one call changed in one Discussion, which its one system Post reports. */
interface DiscussionChanges {
  /** The files that became shared, with the sessions newly listed on each. */
  readonly files: Array<{ readonly path: string; readonly sessionIds: ReadonlyArray<string> }>;
  /** The sessions that joined and cannot receive a Discussion Input, with why. */
  readonly notTold: Map<string, DiscussionInputRefusal>;
  /** The links to the Discussion an overlap went to instead, as sentences. */
  readonly links: Set<string>;
}

/** The changes of one call, by the id of the Discussion they were made in, in the order they began. */
type ChangesByDiscussion = Map<string, DiscussionChanges>;

/** Builds a sentence listing a Discussion's shared files, with at most `MAX_NAMED_FILES` of them. */
const buildSharedFilesLine = (files: DiscussionChanges["files"]): string => {
  const named = files.slice(0, MAX_NAMED_FILES).map((file) => {
    const sessions = file.sessionIds
      .slice(0, MAX_NAMED_SESSIONS_PER_FILE)
      .map((id) => `session ${toIdTail(id)}`);
    const left = file.sessionIds.length - sessions.length;
    const more = left > 0 ? `, and ${left} more sessions` : "";
    return `\`${cutKeepingEnd(file.path, MAX_PATH_LENGTH)}\` (${sessions.join(", ")}${more})`;
  });
  const left = files.length - named.length;
  return `Shared files: ${named.join(", ")}${left > 0 ? `, and ${left} more files` : ""}.`;
};

/** Builds one sentence per session that was not told, naming at most `MAX_NAMED_NOT_TOLD`. */
const buildNotTold = (notTold: DiscussionChanges["notTold"]): ReadonlyArray<string> => {
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

/**
 * Builds the text of a Discussion's one system Post from what a call changed
 * in it (spec 19 section 5.5): a line of shared files, then a line per
 * session not told, then the links. Returns `undefined` when nothing changed.
 * The lines are separated by line breaks, so one Post holds all of them.
 */
const buildSystemPostText = (changes: DiscussionChanges): string | undefined => {
  const links = [...changes.links];
  const lines = [
    ...(changes.files.length > 0 ? [buildSharedFilesLine(changes.files)] : []),
    ...buildNotTold(changes.notTold),
    ...links.slice(0, MAX_NAMED_LINKS),
    ...(links.length > MAX_NAMED_LINKS
      ? [`and ${links.length - MAX_NAMED_LINKS} more overlaps in other discussions.`]
      : []),
  ];
  return lines.length === 0 ? undefined : lines.join("\n");
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const discussions = yield* DiscussionService;
  const edits = yield* editOverlapRepository;
  const resources = yield* resourceRepository;

  /** Returns the record of what a call changed in one Discussion, adding it on first use. */
  const changesIn = (all: ChangesByDiscussion, discussionId: string): DiscussionChanges => {
    const found = all.get(discussionId);
    if (found !== undefined) return found;
    const created: DiscussionChanges = { files: [], notTold: new Map(), links: new Set() };
    all.set(discussionId, created);
    return created;
  };

  /**
   * Runs steps 2 to 6 of spec 19 section 4.3 for one file of an unfinished
   * session: finds the others, chooses the target Discussion, joins and
   * shares, and adds what changed to `all`. Returns the sessions that joined
   * a Discussion.
   */
  const overlapOneFile = (
    sessionId: string,
    file: OverlapFile,
    all: ChangesByDiscussion,
  ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.gen(function* () {
      const editors = yield* edits.listUnfinishedEditors(file.resourceId, file.path);
      const others = editors.map((editor) => editor.sessionId).filter((id) => id !== sessionId);
      if (others.length === 0) return [];

      const candidates = yield* discussions.listOverlapDiscussions(file.resourceId, [
        sessionId,
        ...others,
      ]);
      // A full Discussion is never the target, nor one with no room for a
      // session that is not in it yet.
      const open = candidates.filter(
        (candidate) =>
          !candidate.full &&
          (candidate.participantCount < MAX_PARTICIPANTS ||
            candidate.participantSessionIds.includes(sessionId)),
      );
      const target =
        open.find((candidate) => candidate.participantSessionIds.includes(sessionId)) ??
        open.find((candidate) =>
          candidate.participantSessionIds.some((id) => others.includes(id)),
        ) ??
        (yield* discussions.openOverlapDiscussion(file));

      const joined = yield* discussions.join(target.id, [sessionId, ...others]);
      // The file lists its sessions in the order they edited it.
      const inEditOrder = editors.map((editor) => editor.sessionId).reverse();
      const listed = yield* discussions.shareFile(target.id, file.path, inEditOrder);
      // Nothing new, so a repeated report changes nothing.
      if (joined.length === 0 && listed.length === 0) return [];

      const changes = changesIn(all, target.id);
      if (listed.length > 0) changes.files.push({ path: file.path, sessionIds: listed });
      for (const id of joined) {
        if (changes.notTold.has(id)) continue;
        const refusal = yield* discussions.findDiscussionInputRefusal(id);
        if (refusal !== undefined) changes.notTold.set(id, refusal);
      }
      for (const candidate of candidates) {
        if (candidate.full || candidate.id === target.id) continue;
        if (!candidate.participantSessionIds.some((id) => others.includes(id))) continue;
        changesIn(all, candidate.id).links.add(
          `Session ${toIdTail(sessionId)} also overlaps with sessions in discussion ${target.id} ` +
            `("${target.subject}"). Continue there.`,
        );
      }
      return joined;
    });

  /**
   * Runs the overlap steps for each file of an unfinished session, then
   * writes at most one system Post per Discussion that changed. Returns the
   * sessions that joined a Discussion, each once.
   */
  const overlapFiles = (
    sessionId: string,
    files: ReadonlyArray<OverlapFile>,
  ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.gen(function* () {
      const all: ChangesByDiscussion = new Map();
      const joined = new Set<string>();
      for (const file of files) {
        for (const id of yield* overlapOneFile(sessionId, file, all)) joined.add(id);
      }
      for (const [discussionId, changes] of all) {
        const text = buildSystemPostText(changes);
        if (text !== undefined) yield* discussions.writeSystemPost(discussionId, text);
      }
      return [...joined];
    });

  return {
    /**
     * Records the files a session edited, then puts it into overlap
     * Discussions with the unfinished sessions that edited the same files
     * (spec 19 section 4.3). Returns the sessions that joined a Discussion,
     * which now have a pending entry to be told, each once.
     *
     * A file whose repository is not checked out in the session's workspace
     * is ignored. A finished session records its files and overlaps with
     * no one. Reporting a file again changes nothing. Runs in the caller's
     * transaction; fails only with `SqlError`.
     */
    recordEdits: (
      sessionId: string,
      files: ReadonlyArray<EditedFile>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        const repositories = yield* Effect.provideService(
          listCheckedOutRepositories(sessionId),
          SqlClient.SqlClient,
          sql,
        );
        const at = yield* nowIso;
        const recorded = new Map<string, OverlapFile>();
        for (const { resourceId, path } of files) {
          const repository = repositories.find((candidate) => candidate.resourceId === resourceId);
          if (repository === undefined) continue;
          yield* edits.insertEditIfAbsent(sessionId, resourceId, path, at);
          recorded.set(`${resourceId}\u0000${path}`, { ...repository, path });
        }
        if (!(yield* edits.isUnfinished(sessionId))) return [];
        return yield* overlapFiles(sessionId, [...recorded.values()]);
      }),

    /**
     * Runs the overlap steps again for every file an unfinished session
     * edited (spec 19 section 4.3), for a Thread that was reopened or a
     * session resumed: it meets the sessions that edited the same files while
     * it was finished. Returns the sessions that joined a Discussion, each
     * once. A file of a repository that no longer exists is skipped. Returns
     * none for a session that is not unfinished. Runs in the caller's
     * transaction; fails only with `SqlError`.
     */
    rejoinOverlaps: (sessionId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        if (!(yield* edits.isUnfinished(sessionId))) return [];
        const files: Array<OverlapFile> = [];
        for (const edit of yield* edits.listEditsOf(sessionId)) {
          const resource = Option.getOrUndefined(yield* resources.one(edit.resourceId));
          if (resource?.kind !== "repo") continue;
          files.push({
            resourceId: edit.resourceId,
            repository: resource.canonicalRemote,
            path: edit.path,
          });
        }
        return yield* overlapFiles(sessionId, files);
      }),
  };
});

/** The Edit Overlap service. */
export class EditOverlapService extends Context.Service<
  EditOverlapService,
  Effect.Success<typeof make>
>()("hercule/controller/edit-overlaps/EditOverlapService") {}

export const EditOverlapServiceLayer: Layer.Layer<
  EditOverlapService,
  never,
  SqlClient.SqlClient | DiscussionService
> = Layer.effect(EditOverlapService)(make);
