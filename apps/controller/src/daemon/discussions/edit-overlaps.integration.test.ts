/**
 * Tests Edit Overlaps end to end against a real controller and one fake
 * runner (spec 19 sections 4 and 5.3): sessions report finished edits over
 * the runner socket, and the Discussions are read through the API.
 *
 * - two sessions that edit the same file of one repository meet in one
 *   overlap Discussion, which shares the file and holds one system Post. The
 *   idle session is told by a turn it opens, the busy one by a steer;
 * - a third session that edits the file joins the same Discussion;
 * - a Thread marked Done while another session edits the same file counts
 *   again when it is reopened: it meets that session in an overlap
 *   Discussion;
 * - an Agent's session that exited counts again when input resumes it;
 * - files a session changed through shell commands, reported in a
 *   `filesEdited` frame, count like an edit tool's files.
 */
import { describe, expect, it, vi } from "vitest";
import {
  toIdTail,
  type Discussion,
  type DiscussionWithPosts,
  type Grant,
  type Input,
} from "@hercule/contract";
import { get, post } from "../../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  createProfile,
  findInstanceId,
  listInputs,
  reportEvent,
  reportTurnCompleted,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../../sessions/testing";
import { createRepo, reportWorkspaceReady } from "../../workspaces/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const DISCUSSION_GRANTS: ReadonlyArray<Grant> = ["discussion.read", "discussion.write"];

/** The next sequence number of each session's events: `session.started` was the first. */
const nextSeq = new WeakMap<Arranged, Map<string, number>>();

const takeSeq = (arranged: Arranged, sessionId: string): number => {
  const bySession = nextSeq.get(arranged) ?? new Map<string, number>();
  nextSeq.set(arranged, bySession);
  const seq = bySession.get(sessionId) ?? 2;
  bySession.set(sessionId, seq + 1);
  return seq;
};

/**
 * Spawns a Thread in a new workspace with a checkout of `resourceId`, with
 * the discussion grants, and waits until it is busy with its first turn.
 */
const spawnInRepository = async (
  arranged: Arranged,
  name: string,
  resourceId: string,
): Promise<string> => {
  const profile = await createProfile(arranged, name, DISCUSSION_GRANTS);
  const session = await spawnSessionOrFail(arranged, {
    prompt: "hello",
    permissionProfileId: profile.id,
    workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
  });
  await reportWorkspaceReady(arranged, String(session.workspaceId));
  await waitForStartFrames(arranged, session.id, 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "busy");
  return session.id;
};

/** Has the runner report that the session finished editing `path`, as a completed `file_change` item. */
const reportEdit = (
  arranged: Arranged,
  sessionId: string,
  resourceId: string,
  path: string,
  subagentId?: string,
): void =>
  reportEvent(arranged.wire, takeSeq(arranged, sessionId), {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "item.completed",
    ...(subagentId === undefined ? {} : { subagentId }),
    turnId: "t1",
    itemId: crypto.randomUUID(),
    kind: "file_change",
    status: "completed",
    editedFiles: [{ resourceId, path }],
  });

/** Ends the turn the session is in, so it is idle. */
const endTurn = async (arranged: Arranged, sessionId: string): Promise<void> => {
  reportTurnCompleted(arranged, sessionId, takeSeq(arranged, sessionId));
  await waitForSession(arranged, sessionId, (one) => one.status === "idle");
};

/** Lists the overlap Discussions of a repository through the API, oldest first. */
const listOverlaps = async (arranged: Arranged, resourceId: string): Promise<Array<Discussion>> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/discussions?resourceId=${resourceId}&kind=overlap`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const summaries = ((await response.json()) as { items: ReadonlyArray<{ id: string }> }).items;
  const read = await Promise.all(summaries.map(async ({ id }) => readDiscussion(arranged, id)));
  return read.map((one) => one.discussion).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

const readDiscussion = async (arranged: Arranged, id: string): Promise<DiscussionWithPosts> => {
  const response = await get(arranged.harness.base, `/api/v1/discussions/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as DiscussionWithPosts;
};

/** Waits until the session has a Discussion Input the runner took, and returns it. */
const waitForEntry = (arranged: Arranged, sessionId: string): Promise<Input> =>
  waitUntil("told the session about its entry", async () =>
    (await listInputs(arranged, sessionId)).find(
      (input) => input.source === "discussion" && input.status === "delivered",
    ),
  );

/** Waits until the repository has `count` overlap Discussions, and returns them. */
const waitForOverlaps = (
  arranged: Arranged,
  resourceId: string,
  count: number,
): Promise<Array<Discussion>> =>
  waitUntil(`${String(count)} overlap Discussions`, async () => {
    const found = await listOverlaps(arranged, resourceId);
    return found.length === count ? found : undefined;
  });

const ROUTER = "src/router.ts";
const DATABASE = "src/database.ts";

describe("Edit Overlaps", () => {
  it("puts two sessions that edited the same file into one Discussion, and tells both", async () => {
    await withAgentFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web.git");
      const first = await spawnInRepository(arranged, "first", web);
      const second = await spawnInRepository(arranged, "second", web);
      // Answers as a real runner does: an idle session opens a turn, and a busy one takes the steer.
      arranged.wire.answering((frame) =>
        frame._tag === "sessionInput" && frame.sessionId !== first ? "steered" : "opened",
      );

      reportEdit(arranged, first, web, ROUTER);
      // The runner's events of one session arrive in order, so the idle session
      // means the edit before it was handled. A file edited by one session is no overlap yet.
      await endTurn(arranged, first);
      expect(await listOverlaps(arranged, web)).toEqual([]);
      reportEdit(arranged, second, web, ROUTER);

      const [overlap, ...others] = await waitForOverlaps(arranged, web, 1);
      expect(others).toEqual([]);
      expect(overlap).toMatchObject({
        kind: "overlap",
        repository: "github.com/acme/web",
        // The session that reported the overlap joins first.
        participantSessionIds: [second, first],
      });
      expect(new Set(overlap!.participantSessionIds)).toEqual(new Set([first, second]));
      expect(overlap!.sharedFiles).toHaveLength(1);
      expect(overlap!.sharedFiles[0]).toMatchObject({ path: ROUTER });
      expect(new Set(overlap!.sharedFiles[0]!.sessionIds)).toEqual(new Set([first, second]));
      const { posts } = await readDiscussion(arranged, overlap!.id);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.actor).toBe("system");
      expect(posts[0]!.text).toBe(
        `Shared files: \`${ROUTER}\` (session ${toIdTail(first)}, session ${toIdTail(second)}).`,
      );

      // The idle session's entry opens a turn, and the busy one's is steered into its turn.
      expect(await waitForEntry(arranged, first)).toMatchObject({
        delivery: "opened",
        actor: "system",
      });
      expect(await waitForEntry(arranged, second)).toMatchObject({
        delivery: "steered",
        actor: "system",
      });

      // A third session editing the file joins the same Discussion.
      const third = await spawnInRepository(arranged, "third", web);
      reportEdit(arranged, third, web, ROUTER);
      const joined = await waitUntil("the third session joined", async () => {
        const [one] = await listOverlaps(arranged, web);
        return one!.participantSessionIds.includes(third) ? one : undefined;
      });
      expect(joined.id).toBe(overlap!.id);
      expect(await listOverlaps(arranged, web)).toHaveLength(1);
      expect(new Set(joined.sharedFiles[0]!.sessionIds)).toEqual(new Set([first, second, third]));
      expect(await waitForEntry(arranged, third)).toMatchObject({ delivery: "steered" });
    });
  });

  it("counts a subagent's edit as its session's", async () => {
    await withAgentFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web.git");
      const first = await spawnInRepository(arranged, "first", web);
      const second = await spawnInRepository(arranged, "second", web);

      reportEdit(arranged, first, web, ROUTER, "sub-1");
      reportEdit(arranged, second, web, ROUTER);

      const [overlap] = await waitForOverlaps(arranged, web, 1);
      expect(new Set(overlap!.participantSessionIds)).toEqual(new Set([first, second]));
    });
  });

  it("counts files a session changed through shell commands, which the runner reports in a frame of its own", async () => {
    await withAgentFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web.git");
      const first = await spawnInRepository(arranged, "first", web);
      const second = await spawnInRepository(arranged, "second", web);

      reportEdit(arranged, first, web, ROUTER);
      arranged.wire.send({
        _tag: "filesEdited",
        sessionId: second,
        editedFiles: [{ resourceId: web, path: ROUTER }],
      });

      const [overlap] = await waitForOverlaps(arranged, web, 1);
      expect(new Set(overlap!.participantSessionIds)).toEqual(new Set([first, second]));
    });
  });

  it("brings a Thread that was marked Done into the overlap when it is reopened", async () => {
    await withAgentFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web.git");
      const done = await spawnInRepository(arranged, "done", web);
      const other = await spawnInRepository(arranged, "other", web);

      reportEdit(arranged, done, web, DATABASE);
      const marked = await post(
        arranged.harness.base,
        "/api/v1/sessions/mark-done",
        { sessionIds: [done] },
        arranged.token,
      );
      expect(marked.status, await marked.clone().text()).toBe(200);

      // The Done Thread no longer counts, so this edit finds no one to overlap with.
      reportEdit(arranged, other, web, DATABASE);
      await endTurn(arranged, other);
      expect(await listOverlaps(arranged, web)).toEqual([]);

      const reopened = await post(
        arranged.harness.base,
        "/api/v1/sessions/reopen",
        { sessionIds: [done] },
        arranged.token,
      );
      expect(reopened.status, await reopened.clone().text()).toBe(200);

      const [overlap] = await waitForOverlaps(arranged, web, 1);
      expect(new Set(overlap!.participantSessionIds)).toEqual(new Set([done, other]));
      expect(overlap!.sharedFiles).toMatchObject([{ path: DATABASE }]);
      expect(await waitForEntry(arranged, other)).toMatchObject({ actor: "system" });
      expect(await waitForEntry(arranged, done)).toMatchObject({ actor: "system" });
    });
  });

  it("brings an Agent's exited session into the overlap when input resumes it", async () => {
    await withAgentFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web.git");
      const profile = await createProfile(arranged, "agent-profile", DISCUSSION_GRANTS);
      const created = await post(
        arranged.harness.base,
        "/api/v1/agents",
        {
          name: "editor",
          systemPrompt: "You edit.",
          instanceId: findInstanceId(arranged, "harnesses/full"),
          permissionProfileId: profile.id,
        },
        arranged.token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const agent = (await created.json()) as { readonly id: string };
      const session = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      await reportWorkspaceReady(arranged, String(session.workspaceId));
      await waitForStartFrames(arranged, session.id, 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      reportEdit(arranged, session.id, web, ROUTER);

      arranged.wire.send({
        _tag: "sessionsReport",
        sessions: [
          {
            sessionId: session.id,
            nativeSessionId: "native-1",
            instanceId: findInstanceId(arranged, "harnesses/full"),
          },
        ],
      });
      await waitForSession(arranged, session.id, (one) => one.nativeSessionId !== null);
      reportEvent(arranged.wire, takeSeq(arranged, session.id), {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "exited");

      // The exited session no longer counts, so another session editing the file finds no one.
      const other = await spawnInRepository(arranged, "other", web);
      reportEdit(arranged, other, web, ROUTER);
      await endTurn(arranged, other);
      expect(await listOverlaps(arranged, web)).toEqual([]);

      const resumed = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "carry on" },
        arranged.token,
      );
      expect(resumed.status, await resumed.clone().text()).toBe(200);

      const [overlap] = await waitForOverlaps(arranged, web, 1);
      expect(new Set(overlap!.participantSessionIds)).toEqual(new Set([session.id, other]));
      expect(overlap!.sharedFiles).toMatchObject([{ path: ROUTER }]);
    });
  });
});
