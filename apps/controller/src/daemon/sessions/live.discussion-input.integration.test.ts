/**
 * Tests the Discussion Input over the runner socket, against a real
 * controller and one fake runner (spec 19 section 5): the controller writes
 * it with `SessionService.mentionDiscussions`, and sends it with
 * `Live.steerDiscussionInput` or at the end of a turn.
 *
 * - An entry, an Edit Overlap's first mention of a Discussion, steers a busy
 *   session and opens a turn on an idle Thread.
 * - A mention of new Posts never wakes an idle session. It is sent when the
 *   session's next turn ends, after every other waiting input.
 * - A session holds one unsent Discussion Input, and every mention merges
 *   into it.
 * - A session that cannot receive one is told nothing, and a Discussion
 *   Input is cancelled when its session exits, is marked Done, or can no
 *   longer receive it when it would be sent.
 */
import { describe, expect, it, vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { SessionInput, SessionInterrupt } from "@hercule/protocol";
import { CurrentActor } from "../../actor";
import type { Grant, Input } from "@hercule/contract";
import { post, send } from "../../http/testing";
import {
  SessionService,
  type DiscussionInputRefusal,
  type DiscussionMentions,
} from "../../sessions";
import {
  WAIT_DEADLINE_MS,
  at,
  createProfile,
  listFrames,
  listInputs,
  reportEvent,
  reportTurnCompleted,
  reportTurnStarted,
  spawnThreadUnder,
  spawnThreadWithGrants,
  waitForFrames,
  waitForSession,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../../sessions/testing";
import { readDefaultConversation, startConversationSession } from "../../conversations/testing";
import { Live } from "./live";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const DISCUSSION_GRANTS: ReadonlyArray<Grant> = ["discussion.read", "discussion.write"];

const D1 = "01a13a99-0000-7000-8000-0000000000d1";
const D2 = "01a13a99-0000-7000-8000-0000000000d2";
const EARLY_POST = "01a13a99-0000-7000-8000-0000000000a1";
const LATE_POST = "01a13a99-0000-7000-8000-0000000000a2";
const OTHER_SESSION = "01a13a99-0000-7000-8000-00000000bbbb";

/** An Edit Overlap's first mention of Discussion D1. */
const ENTRY: DiscussionMentions = {
  entries: [
    {
      discussionId: D1,
      repository: "github.com/acme/app",
      files: [{ path: "src/app.ts", sessions: [{ sessionId: OTHER_SESSION, canBeTold: true }] }],
    },
  ],
  newPosts: [],
};

/** Builds a mention of new Posts in one Discussion, from `firstPostId` on. */
const buildNewPosts = (discussionId: string, firstPostId: string): DiscussionMentions => ({
  entries: [],
  newPosts: [{ discussionId, firstPostId }],
});

/** Runs an effect in the controller and returns its value, failing the test on any error. */
const runInController = async <A, E>(
  arranged: Arranged,
  effect: Effect.Effect<A, E, Live | SessionService>,
): Promise<A> => {
  const exit = await arranged.harness.runWithLiveSessions(effect);
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
};

/** Tells the session about Discussions, and returns the refusal, if any. */
const mention = (
  arranged: Arranged,
  sessionId: string,
  mentions: DiscussionMentions,
): Promise<DiscussionInputRefusal | undefined> =>
  runInController(
    arranged,
    Effect.flatMap(SessionService, (sessions) => sessions.mentionDiscussions(sessionId, mentions)),
  );

/** Steers the session's unsent Discussion Input, as the writer of an entry does after its commit. */
const steer = (arranged: Arranged, sessionId: string): Promise<void> =>
  runInController(
    arranged,
    Effect.flatMap(Live, (live) => live.steerDiscussionInput(sessionId)),
  );

/** Returns the session's Discussion Inputs, oldest first. */
const listDiscussionInputs = async (
  arranged: Arranged,
  sessionId: string,
): Promise<ReadonlyArray<Input>> =>
  (await listInputs(arranged, sessionId)).filter((input) => input.source === "discussion");

/** Returns the input frames sent for the session's Discussion Inputs. */
const listDiscussionFrames = (
  arranged: Arranged,
  inputs: ReadonlyArray<Input>,
): ReadonlyArray<SessionInput> =>
  listFrames<SessionInput>(arranged.wire, "sessionInput").filter((frame) =>
    inputs.some((input) => input.id === frame.requestId),
  );

/**
 * Spawns a Thread that holds the discussion grants, and ends its first turn,
 * so it is idle. The runner's next sequence number for it is 3.
 */
const spawnIdleThread = async (arranged: Arranged): Promise<string> => {
  const { session } = await spawnThreadWithGrants(arranged, "discussers", DISCUSSION_GRANTS);
  reportTurnCompleted(arranged, session.id, 2);
  await waitForSession(arranged, session.id, (one) => one.status === "idle");
  return session.id;
};

describe("a mention of new Posts", () => {
  it("never wakes an idle session, and is sent when the next turn another input opens ends", async () => {
    await withAgentFleet(async (arranged) => {
      const sessionId = await spawnIdleThread(arranged);

      expect(await mention(arranged, sessionId, buildNewPosts(D1, EARLY_POST))).toBeUndefined();
      await steer(arranged, sessionId);
      // What the delivery tick does for every session it lists.
      await runInController(
        arranged,
        Effect.flatMap(Live, (live) => live.deliverQueuedInput(sessionId)),
      );

      const [held] = await listDiscussionInputs(arranged, sessionId);
      expect(held).toMatchObject({ status: "queued", sentAt: null, actor: "system" });
      // The mentions are the controller's own record; the API shows only the text.
      expect(held).not.toHaveProperty("discussionMentions");
      expect(held!.text).toBe(
        `New posts in discussion ${D1}. Read them with \`hercule discussion read ${D1} --from ${EARLY_POST}\`.`,
      );
      expect(listDiscussionFrames(arranged, [held!])).toEqual([]);

      const typed = await post(
        arranged.harness.base,
        `/api/v1/sessions/${sessionId}/input`,
        { text: "carry on" },
        arranged.token,
      );
      expect(typed.status, await typed.clone().text()).toBe(200);
      await waitForSession(arranged, sessionId, (one) => one.status === "busy");
      expect(listDiscussionFrames(arranged, [held!])).toEqual([]);

      reportTurnStarted(arranged, sessionId, 3);
      reportTurnCompleted(arranged, sessionId, 4);
      const [frame] = await waitUntil("sent the Discussion Input at the turn's end", () => {
        const found = listDiscussionFrames(arranged, [held!]);
        return found.length > 0 ? found : undefined;
      });
      expect(frame!.input.text).toBe(held!.text);
    });
  });
});

describe("an entry", () => {
  it("is steered into a busy session's running turn", async () => {
    await withAgentFleet(async (arranged) => {
      const { session } = await spawnThreadWithGrants(arranged, "discussers", DISCUSSION_GRANTS);
      arranged.wire.answering(() => "steered");

      expect(await mention(arranged, session.id, ENTRY)).toBeUndefined();
      await steer(arranged, session.id);

      const [input] = await listDiscussionInputs(arranged, session.id);
      expect(input).toMatchObject({ status: "delivered", delivery: "steered" });
      expect(input!.text).toContain(
        "Another session edited files you edited in github.com/acme/app",
      );
      expect(listDiscussionFrames(arranged, [input!])).toHaveLength(1);
    });
  });

  it("interrupts a busy session whose provider cannot steer, as the system, and waits for the turn's end", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { session } = await spawnThreadWithGrants(arranged, "discussers", DISCUSSION_GRANTS);

        expect(await mention(arranged, session.id, ENTRY)).toBeUndefined();
        // A runner report, not a request, commits the entry, so no actor is behind the steer.
        await runInController(
          arranged,
          Effect.flatMap(Live, (live) => live.steerDiscussionInput(session.id)).pipe(
            Effect.provideService(CurrentActor, { _tag: "none" }),
          ),
        );

        const [interrupt] = await waitForFrames<SessionInterrupt>(
          arranged.wire,
          "sessionInterrupt",
          1,
        );
        expect(interrupt!.sessionId).toBe(session.id);
        const entries = await arranged.harness.audit("session.interrupted");
        expect(entries.map((entry) => entry.actor)).toEqual(["system"]);
        const [held] = await listDiscussionInputs(arranged, session.id);
        expect(held).toMatchObject({ status: "queued", sentAt: null });

        reportTurnCompleted(arranged, session.id, 2);
        await waitUntil("sent the Discussion Input at the turn's end", () =>
          listDiscussionFrames(arranged, [held!]).length > 0 ? true : undefined,
        );
      },
      { steering: "unsupported" },
    );
  });

  it("is cancelled, and interrupts nothing, when the session lost the discussion grants", async () => {
    await withAgentFleet(
      async (arranged) => {
        const profile = await createProfile(arranged, "discussers", DISCUSSION_GRANTS);
        const { session } = await spawnThreadUnder(arranged, profile);
        expect(await mention(arranged, session.id, ENTRY)).toBeUndefined();
        const changed = await send(
          "PATCH",
          arranged.harness.base,
          `/api/v1/profiles/${profile.id}`,
          { body: { grants: ["session.read"] }, token: arranged.token },
        );
        expect(changed.status, await changed.clone().text()).toBe(200);

        await steer(arranged, session.id);

        const [input] = await listDiscussionInputs(arranged, session.id);
        expect(input).toMatchObject({ status: "cancelled" });
        expect(input!.reason).toContain("it lacks the discussion grants");
        expect(listFrames<SessionInterrupt>(arranged.wire, "sessionInterrupt")).toEqual([]);
      },
      { steering: "unsupported" },
    );
  });

  it("opens a turn on an idle Thread", async () => {
    await withAgentFleet(async (arranged) => {
      const sessionId = await spawnIdleThread(arranged);

      expect(await mention(arranged, sessionId, ENTRY)).toBeUndefined();
      await steer(arranged, sessionId);

      const [input] = await listDiscussionInputs(arranged, sessionId);
      expect(input).toMatchObject({ status: "delivered", delivery: "opened" });
      await waitForSession(arranged, sessionId, (one) => one.status === "busy");
    });
  });
});

describe("the session's one unsent Discussion Input", () => {
  it("takes every mention, keeping the earliest first Post of each Discussion", async () => {
    await withAgentFleet(async (arranged) => {
      const { session } = await spawnThreadWithGrants(arranged, "discussers", DISCUSSION_GRANTS);

      await mention(arranged, session.id, buildNewPosts(D1, LATE_POST));
      await mention(arranged, session.id, {
        entries: [],
        newPosts: [
          { discussionId: D1, firstPostId: EARLY_POST },
          { discussionId: D2, firstPostId: LATE_POST },
        ],
      });

      const inputs = await listDiscussionInputs(arranged, session.id);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.text).toContain(`hercule discussion read ${D1} --from ${EARLY_POST}`);
      expect(inputs[0]!.text).toContain(`hercule discussion read ${D2} --from ${LATE_POST}`);
    });
  });

  it("takes what a sent Discussion Input mentions when the runner refuses it", async () => {
    await withAgentFleet(async (arranged) => {
      const { session } = await spawnThreadWithGrants(arranged, "discussers", DISCUSSION_GRANTS);
      arranged.wire.answering(() => undefined);
      await mention(arranged, session.id, ENTRY);
      const steering = steer(arranged, session.id);
      const [sent] = await waitUntil("sent the entry", async () => {
        const found = await listDiscussionInputs(arranged, session.id);
        return found[0]?.sentAt === null ? undefined : found;
      });

      // The sent row is never changed, so this mention starts a second row.
      await mention(arranged, session.id, buildNewPosts(D2, EARLY_POST));
      arranged.wire.release({ message: "not now" });
      await steering;

      const inputs = await listDiscussionInputs(arranged, session.id);
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toMatchObject({ id: sent!.id, status: "cancelled" });
      expect(inputs[0]!.reason).toContain("merged into the session's newer one");
      expect(inputs[1]).toMatchObject({ status: "queued", sentAt: null });
      expect(inputs[1]!.text).toContain("Another session edited files you edited");
      expect(inputs[1]!.text).toContain(`hercule discussion read ${D2} --from ${EARLY_POST}`);
    });
  });

  it("is cancelled when its session exits", async () => {
    await withAgentFleet(async (arranged) => {
      const { session } = await spawnThreadWithGrants(arranged, "discussers", DISCUSSION_GRANTS);
      await mention(arranged, session.id, buildNewPosts(D1, EARLY_POST));

      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "exited");

      const [input] = await listDiscussionInputs(arranged, session.id);
      expect(input).toMatchObject({ status: "cancelled" });
      expect(await mention(arranged, session.id, ENTRY)).toBe("not_running");
    });
  });

  it("is cancelled when its Thread is marked Done", async () => {
    await withAgentFleet(async (arranged) => {
      const { session } = await spawnThreadWithGrants(arranged, "discussers", DISCUSSION_GRANTS);
      await mention(arranged, session.id, buildNewPosts(D1, EARLY_POST));

      const marked = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/mark-done`,
        {},
        arranged.token,
      );
      expect(marked.status, await marked.clone().text()).toBe(200);

      const [input] = await listDiscussionInputs(arranged, session.id);
      expect(input).toMatchObject({
        status: "cancelled",
        reason: "the Thread was marked Done before this Discussion Input was sent",
      });
      expect(await mention(arranged, session.id, ENTRY)).toBe("done");
    });
  });

  it("is cancelled instead of sent when its session lost the discussion grants", async () => {
    await withAgentFleet(async (arranged) => {
      const profile = await createProfile(arranged, "discussers", DISCUSSION_GRANTS);
      const { session } = await spawnThreadUnder(arranged, profile);
      await mention(arranged, session.id, buildNewPosts(D1, EARLY_POST));
      const changed = await send("PATCH", arranged.harness.base, `/api/v1/profiles/${profile.id}`, {
        body: { grants: ["session.read"] },
        token: arranged.token,
      });
      expect(changed.status, await changed.clone().text()).toBe(200);

      reportTurnCompleted(arranged, session.id, 2);
      const [input] = await waitUntil("cancelled the Discussion Input", async () => {
        const found = await listDiscussionInputs(arranged, session.id);
        return found[0]?.status === "cancelled" ? found : undefined;
      });
      expect(input!.reason).toContain("it lacks the discussion grants");
      expect(listDiscussionFrames(arranged, [input!])).toEqual([]);
    });
  });
});

describe("a session that cannot receive a Discussion Input", () => {
  it("is told nothing when it lacks the discussion grants", async () => {
    await withAgentFleet(async (arranged) => {
      const { session } = await spawnThreadWithGrants(arranged, "readers", ["discussion.read"]);

      expect(await mention(arranged, session.id, ENTRY)).toBe("lacks_grants");
      expect(await listDiscussionInputs(arranged, session.id)).toEqual([]);
    });
  });

  it("is told nothing when it answers an assistant's conversation", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");

      expect(await mention(arranged, session.id, ENTRY)).toBe("conversation");
      expect(await listDiscussionInputs(arranged, session.id)).toEqual([]);
    });
  });
});
