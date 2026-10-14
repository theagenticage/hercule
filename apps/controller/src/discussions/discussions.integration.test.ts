/**
 * Tests Discussions over HTTP, against a real controller and one fake runner
 * on the socket:
 *
 * - two sessions post in one Discussion with their own tokens, each becomes
 *   a participant, and the Discussion reads back with every Post;
 * - each participant is told once about the other's Posts, when its turn
 *   ends;
 * - a Post never wakes an idle participant.
 */
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { SessionInput } from "@hercule/protocol";
import type { DiscussionCreated, Input, Post } from "@hercule/contract";
import { DiscussionInputs } from "../daemon/discussions";
import { Live } from "../daemon/sessions";
import { get, post } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  endTurnAndSettle,
  listFrames,
  listInputs,
  readSession,
  reportTurnCompleted,
  reportTurnStarted,
  spawnThreadWithGrants,
  waitForSession,
  waitUntil,
  withAgentFleet,
  type Arranged,
  type SpawnedThread,
} from "../sessions/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const DISCUSSION_GRANTS = ["discussion.read", "discussion.write"] as const;

/** Creates a repo Resource through the API and returns its id. */
const createRepository = async (arranged: Arranged): Promise<string> => {
  const resource = await post(
    arranged.harness.base,
    "/api/v1/resources",
    { kind: "repo", remote: "https://github.com/acme/web", workspaceInclude: true },
    arranged.token,
  );
  expect(resource.status, await resource.clone().text()).toBe(200);
  return ((await resource.json()) as { readonly id: string }).id;
};

describe("discussions over HTTP", () => {
  it("lets two sessions post in one Discussion with their own tokens", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const resourceId = await createRepository(arranged);
      const first = await spawnThreadWithGrants(arranged, "first", DISCUSSION_GRANTS);
      const second = await spawnThreadWithGrants(arranged, "second", DISCUSSION_GRANTS);

      const created = await post(
        base,
        "/api/v1/discussions",
        { resourceId, subject: "Who changes the router?", text: "I will." },
        first.token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const { discussion } = (await created.json()) as DiscussionCreated;

      for (const text of ["I take the tests.", "And the docs."]) {
        const posted = await post(
          base,
          `/api/v1/discussions/${discussion.id}/post`,
          { text },
          second.token,
        );
        expect(posted.status, await posted.clone().text()).toBe(200);
      }

      const read = await get(base, `/api/v1/discussions/${discussion.id}`, second.token);
      expect(read.status, await read.clone().text()).toBe(200);
      expect(await read.json()).toMatchObject({
        discussion: {
          repository: "github.com/acme/web",
          postCount: 3,
          participantSessionIds: [first.session.id, second.session.id],
        },
      });
    });
  });
});

/** Opens a Discussion as `author`, and returns it. */
const openDiscussion = async (arranged: Arranged, author: SpawnedThread): Promise<string> => {
  const created = await post(
    arranged.harness.base,
    "/api/v1/discussions",
    { resourceId: await createRepository(arranged), subject: "The router", text: "I take it." },
    author.token,
  );
  expect(created.status, await created.clone().text()).toBe(200);
  return ((await created.json()) as DiscussionCreated).discussion.id;
};

/** Posts `text` in the Discussion as `author`, and returns the Post. */
const postAs = async (
  arranged: Arranged,
  author: SpawnedThread,
  discussionId: string,
  text: string,
): Promise<Post> => {
  const posted = await post(
    arranged.harness.base,
    `/api/v1/discussions/${discussionId}/post`,
    { text },
    author.token,
  );
  expect(posted.status, await posted.clone().text()).toBe(200);
  return (await posted.json()) as Post;
};

/** Returns the session's Discussion Inputs, oldest first. */
const listDiscussionInputs = async (
  arranged: Arranged,
  sessionId: string,
): Promise<ReadonlyArray<Input>> =>
  (await listInputs(arranged, sessionId)).filter((input) => input.source === "discussion");

/** Waits until the session has a Discussion Input the runner answered, and returns them all. */
const waitForTold = (arranged: Arranged, sessionId: string): Promise<ReadonlyArray<Input>> =>
  waitUntil("told the session about its Discussions", async () => {
    const found = await listDiscussionInputs(arranged, sessionId);
    return found.some((input) => input.status === "delivered") ? found : undefined;
  });

/**
 * Ends the session's second turn, then tells it about its Discussions once
 * more, as a turn's end does, and waits for that to finish. A test that
 * checks that a session was told only once reads its inputs after this.
 */
const endAnotherTurn = async (arranged: Arranged, sessionId: string): Promise<void> => {
  reportTurnStarted(arranged, sessionId, 3);
  reportTurnCompleted(arranged, sessionId, 4);
  await waitForSession(arranged, sessionId, (one) => one.status === "idle");
  const told = await arranged.harness.runWithLiveSessions(
    Effect.flatMap(DiscussionInputs, (inputs) => inputs.tellSession(sessionId, "turnEnd")),
  );
  expect(Exit.isSuccess(told)).toBe(true);
};

describe("telling the participants", () => {
  it("tells each participant once about the other's Posts, when its turn ends", async () => {
    await withAgentFleet(async (arranged) => {
      const first = await spawnThreadWithGrants(arranged, "first", DISCUSSION_GRANTS);
      const second = await spawnThreadWithGrants(arranged, "second", DISCUSSION_GRANTS);
      const discussionId = await openDiscussion(arranged, first);
      const secondPosts = [
        await postAs(arranged, second, discussionId, "I take the tests."),
        await postAs(arranged, second, discussionId, "And the docs."),
      ];
      const reply = await postAs(arranged, first, discussionId, "Fine.");

      reportTurnCompleted(arranged, first.session.id, 2);
      reportTurnCompleted(arranged, second.session.id, 2);
      const [toFirst] = await waitForTold(arranged, first.session.id);
      const [toSecond] = await waitForTold(arranged, second.session.id);

      // Each is told from the first Post it had not seen: the other's, never its own.
      expect(toFirst).toMatchObject({ actor: "system", delivery: "opened" });
      expect(toFirst!.text).toContain(`--from ${secondPosts[0]!.id}`);
      expect(toSecond!.text).toContain(`--from ${reply.id}`);
      await endAnotherTurn(arranged, first.session.id);
      await endAnotherTurn(arranged, second.session.id);
      expect(await listDiscussionInputs(arranged, first.session.id)).toHaveLength(1);
      expect(await listDiscussionInputs(arranged, second.session.id)).toHaveLength(1);
    });
  });

  it("never wakes an idle participant", async () => {
    await withAgentFleet(async (arranged) => {
      const idle = await spawnThreadWithGrants(arranged, "idle", DISCUSSION_GRANTS);
      const poster = await spawnThreadWithGrants(arranged, "poster", DISCUSSION_GRANTS);
      // Settled, so the idle session's own turn end has told it nothing
      // before the Post below is written.
      await endTurnAndSettle(
        arranged,
        { sessionId: idle.session.id, seq: 2 },
        { sessionId: poster.session.id, seq: 2 },
      );
      const discussionId = await openDiscussion(arranged, idle);

      await postAs(arranged, poster, discussionId, "I take the tests.");
      // Runs what the delivery tick runs for the session, so a wake the Post
      // caused would have sent its input frame by the time the test looks.
      const delivered = await arranged.harness.runWithLiveSessions(
        Effect.flatMap(Live, (live) => live.deliverQueuedInput(idle.session.id)),
      );
      expect(Exit.isSuccess(delivered)).toBe(true);

      expect(await listDiscussionInputs(arranged, idle.session.id)).toEqual([]);
      const frames = listFrames<SessionInput>(arranged.wire, "sessionInput");
      expect(frames.filter((frame) => frame.sessionId === idle.session.id)).toEqual([]);
      expect((await readSession(arranged, idle.session.id)).status).toBe("idle");
    });
  });
});
