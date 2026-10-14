/**
 * Tests sending the Discussion Input over the runner socket, against a real
 * controller and one fake runner (spec 19 section 5.3):
 *
 * - at a turn's end, every other waiting input goes first, and the session is
 *   told when that input's turn ends. Nothing is sent while another input is
 *   on the wire, nor to a busy session;
 * - a refused Discussion Input is cancelled, and the next turn's end tells
 *   the session again;
 * - an entry steers a busy session, interrupts one whose provider cannot
 *   steer, and opens a turn on an idle Thread but not on an idle step
 *   session;
 * - a session that cannot receive a Discussion Input is told nothing;
 * - two tells of one session never tell the same entry twice.
 *
 * `discussions/discussions.integration.test.ts` covers the Posts over HTTP:
 * each participant is told once, and an idle participant is not woken.
 */
import { describe, expect, it, vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SessionInput, SessionInterrupt } from "@hercule/protocol";
import type { DiscussionCreated, Grant, Input, Post, SessionInputOutcome } from "@hercule/contract";
import { readDefaultConversation, startConversationSession } from "../../conversations/testing";
import { mintUuid, uuidFromString, withTransaction } from "../../db";
import { DiscussionService } from "../../discussions";
import { post, type LiveSessionsServices } from "../../http/testing";
import { QUIET_LOOP_TIMINGS } from "../../promotion/testing";
import {
  WAIT_DEADLINE_MS,
  listFrames,
  listInputs,
  endTurnAndSettle,
  reportTurnCompleted,
  reportTurnStarted,
  spawnThreadWithGrants,
  waitForFrames,
  waitForSession,
  waitUntil,
  withAgentFleet,
  type Arranged,
  type SpawnedThread,
} from "../../sessions/testing";
import { DiscussionInputs, DiscussionInputsLayer, type TellingMoment } from "./discussion-inputs";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const DISCUSSION_GRANTS: ReadonlyArray<Grant> = ["discussion.read", "discussion.write"];

const REPOSITORY = "github.com/acme/web";

/** Runs an effect in the controller and returns its value, failing the test on any error. */
const runInController = async <A, E>(
  arranged: Arranged,
  effect: Effect.Effect<A, E, LiveSessionsServices>,
): Promise<A> => {
  const exit = await arranged.harness.runWithLiveSessions(effect);
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
};

/** Tells the session about its Discussions, as the controller does at `moment`. */
const tell = (arranged: Arranged, sessionId: string, moment: TellingMoment): Promise<void> =>
  runInController(
    arranged,
    Effect.flatMap(DiscussionInputs, (inputs) => inputs.tellSession(sessionId, moment)),
  );

/** Creates a repo Resource through the API and returns its id. */
const createRepository = async (arranged: Arranged): Promise<string> => {
  const resource = await post(
    arranged.harness.base,
    "/api/v1/resources",
    { kind: "repo", remote: `https://${REPOSITORY}`, workspaceInclude: true },
    arranged.token,
  );
  expect(resource.status, await resource.clone().text()).toBe(200);
  return ((await resource.json()) as { readonly id: string }).id;
};

/**
 * Puts both sessions into a new overlap Discussion, as an Edit Overlap does,
 * sharing one file, so each has the Discussion's entry pending.
 */
const arrangeEntry = async (
  arranged: Arranged,
  sessionId: string,
  otherSessionId: string,
): Promise<void> => {
  const resourceId = await createRepository(arranged);
  await runInController(
    arranged,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const discussions = yield* DiscussionService;
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const file = { resourceId, repository: REPOSITORY, path: "src/router.ts" };
          const discussion = yield* discussions.openOverlapDiscussion(file);
          yield* discussions.join(discussion.id, [sessionId, otherSessionId]);
          yield* discussions.shareFile(discussion.id, file.path, [otherSessionId, sessionId]);
        }),
      );
    }),
  );
};

/**
 * Has `told` open a Discussion, and `poster` post in it, through the API, so
 * `told` has one Post it has not been told about. Returns that Post.
 */
const arrangeNewPost = async (
  arranged: Arranged,
  told: SpawnedThread,
  poster: SpawnedThread,
): Promise<Post> => {
  const base = arranged.harness.base;
  const created = await post(
    base,
    "/api/v1/discussions",
    { resourceId: await createRepository(arranged), subject: "The router", text: "I take it." },
    told.token,
  );
  expect(created.status, await created.clone().text()).toBe(200);
  const { discussion } = (await created.json()) as DiscussionCreated;
  const posted = await post(
    base,
    `/api/v1/discussions/${discussion.id}/post`,
    { text: "I take the tests." },
    poster.token,
  );
  expect(posted.status, await posted.clone().text()).toBe(200);
  return (await posted.json()) as Post;
};

/** Spawns two Threads that hold the discussion grants. Both are busy with their first turn. */
const spawnPair = async (arranged: Arranged): Promise<readonly [SpawnedThread, SpawnedThread]> => [
  await spawnThreadWithGrants(arranged, "first", DISCUSSION_GRANTS),
  await spawnThreadWithGrants(arranged, "second", DISCUSSION_GRANTS),
];

/** Ends the session's running turn, reported at `seq`, and waits until it is idle. */
const endTurn = async (arranged: Arranged, sessionId: string, seq: number): Promise<void> => {
  reportTurnCompleted(arranged, sessionId, seq);
  await waitForSession(arranged, sessionId, (one) => one.status === "idle");
};

/** Returns the session's Discussion Inputs, oldest first. */
const listDiscussionInputs = async (
  arranged: Arranged,
  sessionId: string,
): Promise<ReadonlyArray<Input>> =>
  (await listInputs(arranged, sessionId)).filter((input) => input.source === "discussion");

/** Waits until the session has `count` Discussion Inputs that are no longer on the wire, and returns them. */
const waitForSettledDiscussionInputs = (
  arranged: Arranged,
  sessionId: string,
  count: number,
): Promise<ReadonlyArray<Input>> =>
  waitUntil(`settled ${String(count)} Discussion Inputs`, async () => {
    const found = await listDiscussionInputs(arranged, sessionId);
    return found.length >= count && found.every((input) => input.status !== "queued")
      ? found
      : undefined;
  });

/** Returns the input frames sent to the session's runner for the input `inputId`. */
const listInputFrames = (arranged: Arranged, inputId: string): ReadonlyArray<SessionInput> =>
  listFrames<SessionInput>(arranged.wire, "sessionInput").filter(
    (frame) => frame.requestId === inputId,
  );

describe("a Discussion Input at a turn's end", () => {
  it("goes after every other waiting input, when that input's turn ends", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      const untold = await arrangeNewPost(arranged, first, second);
      const typed = await post(
        arranged.harness.base,
        `/api/v1/sessions/${first.session.id}/input`,
        { text: "carry on" },
        arranged.token,
      );
      expect(typed.status, await typed.clone().text()).toBe(200);
      const { inputId } = (await typed.json()) as SessionInputOutcome;

      reportTurnCompleted(arranged, first.session.id, 2);
      await waitUntil("sent the waiting input", () =>
        listInputFrames(arranged, inputId).length > 0 ? true : undefined,
      );
      expect(await listDiscussionInputs(arranged, first.session.id)).toEqual([]);

      reportTurnStarted(arranged, first.session.id, 3);
      reportTurnCompleted(arranged, first.session.id, 4);
      const [told] = await waitForSettledDiscussionInputs(arranged, first.session.id, 1);
      expect(told).toMatchObject({ status: "delivered", delivery: "opened", actor: "system" });
      expect(told!.text).toContain(`--from ${untold.id}`);
      expect(listInputFrames(arranged, told!.id)).toHaveLength(1);
    });
  });

  it("is cancelled when the runner refuses it, and the next turn's end tells the session again", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      await arrangeNewPost(arranged, first, second);
      arranged.wire.answering(() => ({ message: "not now" }));

      await endTurn(arranged, first.session.id, 2);
      const [refused] = await waitForSettledDiscussionInputs(arranged, first.session.id, 1);
      expect(refused).toMatchObject({ status: "cancelled", sentAt: null });
      expect(refused!.reason).toContain("not now");

      arranged.wire.answering(() => "opened");
      const typed = await post(
        arranged.harness.base,
        `/api/v1/sessions/${first.session.id}/input`,
        { text: "carry on" },
        arranged.token,
      );
      expect(typed.status, await typed.clone().text()).toBe(200);
      reportTurnStarted(arranged, first.session.id, 3);
      reportTurnCompleted(arranged, first.session.id, 4);

      const told = await waitForSettledDiscussionInputs(arranged, first.session.id, 2);
      expect(told[1]).toMatchObject({ status: "delivered", delivery: "opened" });
      expect(told[1]!.text).toBe(refused!.text);
    });
  });
  it("is not sent while another input of the session is on the wire", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      await endTurnAndSettle(
        arranged,
        { sessionId: first.session.id, seq: 2 },
        { sessionId: second.session.id, seq: 2 },
      );
      await arrangeNewPost(arranged, first, second);
      arranged.wire.answering(() => undefined);
      const typing = post(
        arranged.harness.base,
        `/api/v1/sessions/${first.session.id}/input`,
        { text: "carry on" },
        arranged.token,
      );
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);

      await tell(arranged, first.session.id, "turnEnd");

      expect(await listDiscussionInputs(arranged, first.session.id)).toEqual([]);
      arranged.wire.release("opened");
      expect((await typing).status).toBe(200);
    });
  });

  it("is not sent to an idle session while another input waits", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      await endTurnAndSettle(
        arranged,
        { sessionId: first.session.id, seq: 2 },
        { sessionId: second.session.id, seq: 2 },
      );
      await arrangeNewPost(arranged, first, second);
      // A refused input goes back to waiting, and the session stays idle
      // with nothing on the wire. No delivery tick runs to send it again.
      arranged.wire.answering(() => ({ message: "not now" }));
      const typed = await post(
        arranged.harness.base,
        `/api/v1/sessions/${first.session.id}/input`,
        { text: "carry on" },
        arranged.token,
      );
      expect(typed.status).toBe(409);
      arranged.wire.answering(() => "opened");

      await tell(arranged, first.session.id, "turnEnd");

      expect(await listDiscussionInputs(arranged, first.session.id)).toEqual([]);
    }, QUIET_LOOP_TIMINGS);
  });

  it("is not sent to a busy session at a turn's end", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      await arrangeNewPost(arranged, first, second);

      await tell(arranged, first.session.id, "turnEnd");

      expect(await listDiscussionInputs(arranged, first.session.id)).toEqual([]);
    });
  });
});

describe("an entry", () => {
  it("is steered into a busy session's running turn, and is told once", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      await arrangeEntry(arranged, first.session.id, second.session.id);
      arranged.wire.answering(() => "steered");

      await tell(arranged, first.session.id, "entry");

      const [steered] = await listDiscussionInputs(arranged, first.session.id);
      expect(steered).toMatchObject({ status: "delivered", delivery: "steered", actor: "system" });
      expect(steered!.text).toContain(`Another session edited files you edited in ${REPOSITORY}`);

      // The entry was told, so the turn's end has nothing more to tell.
      await endTurn(arranged, first.session.id, 2);
      await tell(arranged, first.session.id, "turnEnd");
      expect(await listDiscussionInputs(arranged, first.session.id)).toHaveLength(1);
    });
  });

  it("interrupts a busy session whose provider cannot steer, as the system, and is told at the turn's end", async () => {
    await withAgentFleet(
      async (arranged) => {
        const [first, second] = await spawnPair(arranged);
        await arrangeEntry(arranged, first.session.id, second.session.id);

        // The test runs the call as the user; the interrupt is still the system's.
        await tell(arranged, first.session.id, "entry");

        const [interrupt] = await waitForFrames<SessionInterrupt>(
          arranged.wire,
          "sessionInterrupt",
          1,
        );
        expect(interrupt!.sessionId).toBe(first.session.id);
        const entries = await arranged.harness.audit("session.interrupted");
        expect(entries.map((entry) => entry.actor)).toEqual(["system"]);
        expect(await listDiscussionInputs(arranged, first.session.id)).toEqual([]);

        reportTurnCompleted(arranged, first.session.id, 2);
        const [told] = await waitForSettledDiscussionInputs(arranged, first.session.id, 1);
        expect(told).toMatchObject({ status: "delivered", delivery: "opened" });
        expect(told!.text).toContain("Another session edited files you edited");
      },
      { steering: "unsupported" },
    );
  });

  it("opens a turn on an idle Thread", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      await endTurnAndSettle(
        arranged,
        { sessionId: first.session.id, seq: 2 },
        { sessionId: second.session.id, seq: 2 },
      );
      await arrangeEntry(arranged, first.session.id, second.session.id);

      await tell(arranged, first.session.id, "entry");

      const [opened] = await listDiscussionInputs(arranged, first.session.id);
      expect(opened).toMatchObject({ status: "delivered", delivery: "opened" });
    });
  });

  it("opens no turn on an idle agent step's session, which is told at a turn's end", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      await endTurnAndSettle(
        arranged,
        { sessionId: first.session.id, seq: 2 },
        { sessionId: second.session.id, seq: 2 },
      );
      await arrangeEntry(arranged, first.session.id, second.session.id);
      // Only the run a session belongs to tells a step session from a Thread
      // here, and no foreign key holds the column, so a made-up run will do.
      await runInController(
        arranged,
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql`UPDATE sessions SET run_id = ${mintUuid()} WHERE id = ${uuidFromString(first.session.id)}`,
        ),
      );

      await tell(arranged, first.session.id, "entry");
      expect(await listDiscussionInputs(arranged, first.session.id)).toEqual([]);

      await tell(arranged, first.session.id, "turnEnd");
      expect(await listDiscussionInputs(arranged, first.session.id)).toHaveLength(1);
    });
  });

  it("sends nothing for new Posts alone, which wait for a turn's end", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      await endTurnAndSettle(
        arranged,
        { sessionId: first.session.id, seq: 2 },
        { sessionId: second.session.id, seq: 2 },
      );
      await arrangeNewPost(arranged, first, second);

      await tell(arranged, first.session.id, "entry");
      expect(await listDiscussionInputs(arranged, first.session.id)).toEqual([]);

      await tell(arranged, first.session.id, "turnEnd");
      expect(await listDiscussionInputs(arranged, first.session.id)).toHaveLength(1);
    });
  });
});

describe("a session that cannot receive a Discussion Input", () => {
  /** Tells the session at a turn's end and at an entry, and checks that nothing was written. */
  const expectToldNothing = async (arranged: Arranged, sessionId: string): Promise<void> => {
    await tell(arranged, sessionId, "turnEnd");
    await tell(arranged, sessionId, "entry");
    expect(await listDiscussionInputs(arranged, sessionId)).toEqual([]);
  };

  it("is told nothing when it lacks the discussion grants", async () => {
    await withAgentFleet(async (arranged) => {
      const reader = await spawnThreadWithGrants(arranged, "readers", ["discussion.read"]);
      const other = await spawnThreadWithGrants(arranged, "other", DISCUSSION_GRANTS);
      await endTurnAndSettle(
        arranged,
        { sessionId: reader.session.id, seq: 2 },
        { sessionId: other.session.id, seq: 2 },
      );
      await arrangeEntry(arranged, reader.session.id, other.session.id);

      await expectToldNothing(arranged, reader.session.id);
    });
  });

  it("is told nothing when it is a Thread marked Done", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      await endTurnAndSettle(
        arranged,
        { sessionId: first.session.id, seq: 2 },
        { sessionId: second.session.id, seq: 2 },
      );
      await arrangeEntry(arranged, first.session.id, second.session.id);
      const marked = await post(
        arranged.harness.base,
        `/api/v1/sessions/${first.session.id}/mark-done`,
        {},
        arranged.token,
      );
      expect(marked.status, await marked.clone().text()).toBe(200);

      await expectToldNothing(arranged, first.session.id);
    });
  });

  it("is told nothing when it answers an assistant's conversation", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      const other = await spawnThreadWithGrants(arranged, "other", DISCUSSION_GRANTS);
      await arrangeEntry(arranged, session.id, other.session.id);

      await expectToldNothing(arranged, session.id);
    });
  });
});

describe("two tells of one session", () => {
  it("tell an entry once, when one tell drafted it and waits while the other one runs", async () => {
    await withAgentFleet(async (arranged) => {
      const [first, second] = await spawnPair(arranged);
      await endTurnAndSettle(
        arranged,
        { sessionId: first.session.id, seq: 2 },
        { sessionId: second.session.id, seq: 2 },
      );
      await arrangeEntry(arranged, first.session.id, second.session.id);

      await runInController(
        arranged,
        Effect.gen(function* () {
          // A Discussion service whose first draft waits once it is drafted,
          // as a tell does that waits on the database between its draft and
          // its send. Built into a DiscussionInputs of its own, so both tells
          // below share that one instance.
          const real = yield* DiscussionService;
          const drafted = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          let drafts = 0;
          const pausing = Layer.succeed(DiscussionService, {
            ...real,
            draftDiscussionInput: (sessionId) =>
              (drafts += 1) === 1
                ? Effect.tap(real.draftDiscussionInput(sessionId), () =>
                    Effect.andThen(Deferred.succeed(drafted, undefined), Deferred.await(resume)),
                  )
                : real.draftDiscussionInput(sessionId),
          });
          const inputs = yield* Effect.provide(
            Effect.service(DiscussionInputs),
            // Fresh, because the controller has already built this layer, and
            // providing it again would return that instance.
            Layer.fresh(DiscussionInputsLayer).pipe(Layer.provide(pausing)),
          );

          const entry = yield* Effect.forkChild(inputs.tellSession(first.session.id, "entry"));
          yield* Deferred.await(drafted);
          const turnEnd = yield* Effect.forkChild(inputs.tellSession(first.session.id, "turnEnd"));
          // Without a lock per session, the second tell sends the entry and
          // ends well within this wait, and the first then sends its stale
          // draft. With the lock, the second tell waits for the first.
          yield* Effect.ignore(Effect.timeout(Fiber.await(turnEnd), "1 second"));
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(entry);
          yield* Fiber.join(turnEnd);
        }),
      );

      const told = await waitForSettledDiscussionInputs(arranged, first.session.id, 1);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ status: "delivered" });
    });
  });
});
