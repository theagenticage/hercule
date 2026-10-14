/**
 * Tests Discussions over HTTP, against a real controller and one fake runner
 * on the socket:
 *
 * - two sessions post in one Discussion with their own tokens, and the other
 *   participant's mentions of new Posts merge into its one unsent Discussion
 *   Input;
 * - a Post never wakes an idle participant.
 */
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { SessionInput } from "@hercule/protocol";
import type { DiscussionCreated, Post } from "@hercule/contract";
import { Live } from "../daemon/sessions";
import { get, post } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  listFrames,
  listInputs,
  readSession,
  reportTurnCompleted,
  spawnThreadWithGrants,
  waitForSession,
  withAgentFleet,
  type Arranged,
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
  it("merges two new Posts into the other participant's one unsent Discussion Input", async () => {
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

      const posts: Array<Post> = [];
      for (const text of ["I take the tests.", "And the docs."]) {
        const posted = await post(
          base,
          `/api/v1/discussions/${discussion.id}/post`,
          { text },
          second.token,
        );
        expect(posted.status, await posted.clone().text()).toBe(200);
        posts.push((await posted.json()) as Post);
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

      // The first session's turn is still running, so its Discussion Input
      // waits, and names the first Post it has not been told about.
      const told = (await listInputs(arranged, first.session.id)).filter(
        (input) => input.source === "discussion",
      );
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ status: "queued", sentAt: null, actor: "system" });
      expect(told[0]!.text).toContain(`--from ${posts[0]!.id}`);
      // The author is never told about its own Posts.
      const authorInputs = await listInputs(arranged, second.session.id);
      expect(authorInputs.filter((input) => input.source === "discussion")).toEqual([]);
    });
  });

  it("never wakes an idle participant: its Discussion Input waits, unsent", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const resourceId = await createRepository(arranged);
      const idle = await spawnThreadWithGrants(arranged, "idle", DISCUSSION_GRANTS);
      const poster = await spawnThreadWithGrants(arranged, "poster", DISCUSSION_GRANTS);
      const created = await post(
        base,
        "/api/v1/discussions",
        { resourceId, subject: "Who changes the router?", text: "I will." },
        idle.token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const { discussion } = (await created.json()) as DiscussionCreated;
      reportTurnCompleted(arranged, idle.session.id, 2);
      await waitForSession(arranged, idle.session.id, (one) => one.status === "idle");

      const posted = await post(
        base,
        `/api/v1/discussions/${discussion.id}/post`,
        { text: "I take the tests." },
        poster.token,
      );
      expect(posted.status, await posted.clone().text()).toBe(200);
      // Runs what the delivery tick runs for the session, so a wake the Post
      // caused would have sent its input frame by the time the test looks.
      const delivered = await arranged.harness.runWithLiveSessions(
        Effect.flatMap(Live, (live) => live.deliverQueuedInput(idle.session.id)),
      );
      expect(Exit.isSuccess(delivered)).toBe(true);

      const held = (await listInputs(arranged, idle.session.id)).filter(
        (input) => input.source === "discussion",
      );
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ status: "queued", sentAt: null });
      const frames = listFrames<SessionInput>(arranged.wire, "sessionInput");
      expect(frames.filter((frame) => frame.sessionId === idle.session.id)).toEqual([]);
      expect((await readSession(arranged, idle.session.id)).status).toBe("idle");
    });
  });
});
