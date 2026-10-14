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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { EditedFile } from "@hercule/protocol";
import { nowIso } from "../db";
import {
  buildSystemPostText,
  DiscussionService,
  type OverlapFile,
  type SystemPostChanges,
} from "../discussions";
import { sessionRepository } from "../sessions";
import { listCheckedOutRepositories } from "../workspaces";
import { editOverlapRepository } from "./repository";

/** The changes of one call, by the id of the Discussion they were made in, in the order they began. */
type ChangesByDiscussion = Map<string, SystemPostChanges>;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const discussions = yield* DiscussionService;
  const edits = yield* editOverlapRepository;
  const sessions = yield* sessionRepository;

  /** Returns the record of what a call changed in one Discussion, adding it on first use. */
  const ensureDiscussionChanges = (
    all: ChangesByDiscussion,
    discussionId: string,
  ): SystemPostChanges => {
    const found = all.get(discussionId);
    if (found !== undefined) return found;
    const created: SystemPostChanges = {
      files: [],
      notTold: new Map(),
      leftOut: new Set(),
      links: [],
    };
    all.set(discussionId, created);
    return created;
  };

  /**
   * Handles one file of an unfinished session (spec 19 section 4.3, steps 2
   * to 6), and adds what changed to `all`:
   *
   * 1. Finds the other unfinished sessions that edited the file. With none,
   *    there is no overlap and nothing changes.
   * 2. Chooses the target Discussion among the open overlap Discussions of
   *    the repository: the one the session takes part in, else the oldest one
   *    that holds one of the others and has room, else a new one.
   * 3. Joins the session and the others, and lists them on the shared file.
   * 4. Links the other open Discussions that hold one of the others.
   *
   * When no session joined and no file listed a new session, nothing changed,
   * so nothing is recorded. That is so even when sessions were left out for
   * lack of room: they are reported only together with a change, and the
   * same sessions are not reported again by a report that changes nothing.
   *
   * Returns the sessions that joined a Discussion.
   */
  const overlapOneFile = (
    sessionId: string,
    file: OverlapFile,
    all: ChangesByDiscussion,
  ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.gen(function* () {
      // The first to edit the file comes first, which is the order the file lists them in.
      const editors = yield* edits.listUnfinishedEditors(file.resourceId, file.path);
      const others = editors.filter((id) => id !== sessionId);
      if (others.length === 0) return [];

      const candidates = yield* discussions.listOpenOverlapDiscussions(file.resourceId, [
        sessionId,
        ...others,
      ]);
      // A Discussion that holds none of the others is no reason to join it.
      const usable = candidates.filter(
        (candidate) =>
          candidate.participantSessionIds.includes(sessionId) ||
          (candidate.hasRoom && candidate.participantSessionIds.some((id) => others.includes(id))),
      );
      const target =
        usable.find((candidate) => candidate.participantSessionIds.includes(sessionId)) ??
        usable[0] ??
        (yield* discussions.openOverlapDiscussion(file));

      // The session that reported joins first, then the others, the latest editor first.
      const { joined, leftOut } = yield* discussions.join(target.id, [
        sessionId,
        ...[...others].reverse(),
      ]);
      const listed = yield* discussions.shareFile(target.id, file.path, editors);
      if (joined.length === 0 && listed.length === 0) return [];

      const changes = ensureDiscussionChanges(all, target.id);
      if (listed.length > 0) changes.files.push({ path: file.path, sessionIds: listed });
      for (const id of leftOut) changes.leftOut.add(id);
      for (const id of joined) {
        if (changes.notTold.has(id)) continue;
        const refusal = yield* discussions.findDiscussionInputRefusal(id);
        if (refusal !== undefined) changes.notTold.set(id, refusal);
      }
      for (const candidate of candidates) {
        if (candidate.id === target.id) continue;
        if (!candidate.participantSessionIds.some((id) => others.includes(id))) continue;
        const links = ensureDiscussionChanges(all, candidate.id).links;
        if (links.some((link) => link.sessionId === sessionId && link.discussionId === target.id)) {
          continue;
        }
        links.push({ sessionId, discussionId: target.id, subject: target.subject });
      }
      return joined;
    });

  /**
   * Handles each file of an unfinished session, then writes at most one
   * system Post per Discussion that changed. Returns the sessions that joined
   * a Discussion, each once.
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
        const newFiles: Array<OverlapFile> = [];
        for (const { resourceId, path } of files) {
          // The controller records only a repository that is checked out in
          // the session's workspace (spec 19 section 4.1). A late report for
          // a workspace whose checkout is gone drops its edits.
          const repository = repositories.find((candidate) => candidate.resourceId === resourceId);
          if (repository === undefined) continue;
          if (yield* edits.insertEditIfAbsent(sessionId, resourceId, path, at)) {
            newFiles.push({ ...repository, path });
          }
        }
        // Only a file the session had not edited before can change anything. A
        // file it edited before was handled when it was first recorded, or is
        // handled by `rejoinOverlaps` if the session was finished then and
        // becomes unfinished again.
        if (newFiles.length === 0 || !(yield* sessions.isUnfinished(sessionId))) return [];
        return yield* overlapFiles(sessionId, newFiles);
      }),

    /**
     * Handles every file an unfinished session edited again (spec 19 section
     * 4.3), for a Thread that was reopened or a session resumed: it meets the
     * sessions that edited the same files while it was finished. Returns the
     * sessions that joined a Discussion, each once. A file of a repository
     * that no longer exists is skipped. Returns none for a session that is
     * not unfinished. Runs in the caller's transaction; fails only with
     * `SqlError`.
     */
    rejoinOverlaps: (sessionId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        if (!(yield* sessions.isUnfinished(sessionId))) return [];
        return yield* overlapFiles(sessionId, yield* edits.listEditedFiles(sessionId));
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
