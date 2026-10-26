/**
 * Tests for the async questions of the Codex adapter, run against the scripted
 * app-server. The item and its two notifications are the ones captured from
 * codex 0.163.0 when the model called `request_user_input_async` (the
 * `agentMessage` item with `delivery: "async"`, sent once on `item/started`
 * and once on `item/completed`). The real binary is covered by
 * `adapter.integration.test.ts`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { ProviderEvent } from "@hercule/protocol";
import { AnswerNotDelivered } from "../answer-not-delivered";
import { RPC_DEADLINE } from "./rpc";
import {
  buildRefusal,
  cleanupHomes,
  filterByTag,
  listSentParams,
  SESSION,
  settle,
  SILENT,
  startBusySession,
  THREAD,
  TURN,
  waitUntil,
  type Spawn,
} from "./testing";

afterAll(cleanupHomes);

const ITEM_ID = "call_7c2a59c7b036446aaf0aaa6df4e3200f";
const TITLE = "Tool test: Did this structured question reach you?";

const ASYNC_ITEM = {
  type: "agentMessage",
  id: ITEM_ID,
  text: `${TITLE}\n- Yes\n- No`,
  phase: "final_answer",
  delivery: "async",
  questions: [{ title: TITLE, options: ["Yes", "No"] }],
};

const buildItemNote = (
  method: "item/started" | "item/completed",
  item: unknown,
  threadId = THREAD,
) => ({
  method,
  params: {
    threadId,
    turnId: TURN,
    item,
    [method === "item/started" ? "startedAtMs" : "completedAtMs"]: 1,
  },
});

type Run = Awaited<ReturnType<typeof startBusySession>>;

/** Sends the item the way Codex does, started and then completed, and waits for the Request. */
const askAsyncQuestion = async (run: Run, item: unknown = ASYNC_ITEM): Promise<string> => {
  const before = filterByTag(run.seen, "request.opened").length;
  run.server.push(buildItemNote("item/started", item));
  run.server.push(buildItemNote("item/completed", item));
  await waitUntil(
    "opened the async question",
    () => filterByTag(run.seen, "request.opened").length === before + 1,
  );
  return filterByTag(run.seen, "request.opened")[before]!.request.requestId;
};

const completeTurn = async (run: Run): Promise<void> => {
  run.server.push({
    method: "turn/completed",
    params: {
      threadId: THREAD,
      turn: { id: TURN, items: [], itemsView: "full", status: "completed" },
    },
  });
  await waitUntil("ended the turn", () => filterByTag(run.seen, "turn.completed").length === 1);
};

const answer = (run: Run, requestId: string, answers: Record<string, string | Array<string>>) =>
  Effect.runPromise(run.adapter.respondToQuestion(SESSION, requestId, answers as never));

const fail = (run: Run, requestId: string, answers: Record<string, string | Array<string>>) =>
  Effect.runPromise(
    Effect.flip(run.adapter.respondToQuestion(SESSION, requestId, answers as never)),
  );

/** Returns the replies of the envelope in the one text input of a `turn/steer` or `turn/start`. */
const readEnvelope = (
  params: unknown,
): { readonly text: string; readonly replies: Array<Record<string, string>> } => {
  const input = (params as { input: Array<{ type: string; text: string }> }).input;
  expect(input).toHaveLength(1);
  const text = input[0]!.text;
  const match =
    /^<send_user_message_question_reply>\n(.*)\n<\/send_user_message_question_reply>$/s.exec(text);
  expect(match, text).not.toBeNull();
  return { text, replies: JSON.parse(match![1]!) as Array<Record<string, string>> };
};

describe("a Codex async question", () => {
  it("shows its text once and opens one answerable Request", async () => {
    const run = await startBusySession();

    const requestId = await askAsyncQuestion(run);
    await settle();

    // Codex sends no deltas for this item, so the text must still reach the stream.
    expect(
      filterByTag(run.seen, "content.delta").map((event) => [
        event.itemId,
        event.streamKind,
        event.delta,
      ]),
    ).toEqual([[ITEM_ID, "assistant_text", ASYNC_ITEM.text]]);
    expect(filterByTag(run.seen, "request.opened")).toHaveLength(1);
    expect(filterByTag(run.seen, "request.opened")[0]?.request).toEqual({
      requestId,
      itemId: ITEM_ID,
      kind: "question",
      async: true,
      detail: {
        questions: [
          {
            question: TITLE,
            header: "Question",
            options: [{ label: "Yes" }, { label: "No" }],
            multiSelect: false,
          },
        ],
      },
    });
    // The text comes before the item completes, and the Request after it.
    const at = (matches: (event: ProviderEvent) => boolean): number => run.seen.findIndex(matches);
    const completed = at((event) => event._tag === "item.completed" && event.itemId === ITEM_ID);
    expect(at((event) => event._tag === "content.delta")).toBeLessThan(completed);
    expect(completed).toBeLessThan(at((event) => event._tag === "request.opened"));
    for (const event of run.seen)
      expect(Schema.is(ProviderEvent)(event), JSON.stringify(event)).toBe(true);
  });

  it("delivers an answer to a busy agent as one steer, shows it readably, and closes the Request after", async () => {
    const run = await startBusySession();
    const requestId = await askAsyncQuestion(run);

    await answer(run, requestId, { Question: "Yes" });

    const steers = listSentParams(run.requests, "turn/steer");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatchObject({ threadId: THREAD, expectedTurnId: TURN });
    expect(readEnvelope(steers[0]).replies).toEqual([
      {
        answer: "Yes",
        question: TITLE,
        questionItemId: JSON.stringify(["request_user_input_async", ITEM_ID, 0]),
      },
    ]);
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(1);
    const after = run.seen.slice(run.seen.findIndex((event) => event._tag === "request.opened"));
    const message = filterByTag(after, "item.completed").find(
      (event) => event.kind === "user_message",
    );
    // The transcript shows the readable answer, never the envelope.
    expect(message?.detail).toEqual({ text: `> ${TITLE}\n\nYes`, steered: true });
    expect(after.map((event) => event._tag).slice(-1)).toEqual(["request.resolved"]);
    expect(filterByTag(after, "request.resolved")[0]).toMatchObject({
      requestId,
      answers: { Question: "Yes" },
    });
  });

  it("starts a turn with the session's model when the agent is idle", async () => {
    const run = await startBusySession();
    const requestId = await askAsyncQuestion(run);
    await completeTurn(run);
    // The question outlives the turn that asked it.
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);

    await answer(run, requestId, { Question: "No" });

    expect(listSentParams(run.requests, "turn/steer")).toEqual([]);
    const starts = listSentParams(run.requests, "turn/start");
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ threadId: THREAD, model: "gpt-5.5" });
    expect(readEnvelope(starts[1]).replies[0]).toMatchObject({ answer: "No" });
    const message = filterByTag(run.seen, "item.completed")
      .filter((event) => event.kind === "user_message")
      .at(-1);
    expect(message?.detail).toEqual({ text: `> ${TITLE}\n\nNo` });
    expect(filterByTag(run.seen, "request.resolved")).toHaveLength(1);
  });

  it("carries several questions, free text and a list answer, and cuts long titles by bytes", async () => {
    const run = await startBusySession();
    const long = `${"é".repeat(300)}\nsecond line`;
    const requestId = await askAsyncQuestion(run, {
      ...ASYNC_ITEM,
      id: "call_many",
      questions: [
        { title: TITLE, options: ["Yes", "No", "Yes", ""] },
        { title: long, options: null },
      ],
    });
    const opened = filterByTag(run.seen, "request.opened")[0]!.request;
    expect(opened.kind === "question" && opened.detail.questions).toEqual([
      {
        question: TITLE,
        header: "Question 1",
        options: [{ label: "Yes" }, { label: "No" }],
        multiSelect: false,
      },
      { question: long, header: "Question 2", options: [], multiSelect: false },
    ]);

    await answer(run, requestId, {
      "Question 1": ["Yes", "No"],
      "Question 2": 'free "text"\nwith a line',
    });

    const { replies } = readEnvelope(listSentParams(run.requests, "turn/steer")[0]);
    expect(replies.map((reply) => reply["answer"])).toEqual([
      "Yes, No",
      'free "text"\nwith a line',
    ]);
    expect(replies.map((reply) => reply["questionItemId"])).toEqual([
      JSON.stringify(["request_user_input_async", "call_many", 0]),
      JSON.stringify(["request_user_input_async", "call_many", 1]),
    ]);
    // 512 bytes of two-byte characters is 256 characters, and the line break is a space.
    expect(replies[1]!["question"]).toBe("é".repeat(256));
    const shown = filterByTag(run.seen, "item.completed")
      .filter((event) => event.kind === "user_message")
      .at(-1);
    expect(shown?.detail).toEqual({
      text: `> ${TITLE}\n\nYes, No\n\n> ${long}\n\nfree "text"\nwith a line`,
      steered: true,
    });
  });

  it("stays open after Codex refuses the answer, and a retry delivers it", async () => {
    let refusals = 1;
    const run = await startBusySession({
      "turn/steer": () =>
        refusals-- > 0 ? buildRefusal("failed to steer turn: boom", -32603) : { turnId: TURN },
    });
    const requestId = await askAsyncQuestion(run);

    const failure = await fail(run, requestId, { Question: "Yes" });

    expect(failure).toBeInstanceOf(AnswerNotDelivered);
    expect(failure.message).toContain("boom");
    // A refused steer is not a reason to start a turn: the answer would arrive twice if the steer had landed.
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(1);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
    expect(
      filterByTag(run.seen, "item.completed").filter((event) => event.kind === "user_message"),
    ).toHaveLength(1);

    await answer(run, requestId, { Question: "Yes" });

    expect(listSentParams(run.requests, "turn/steer")).toHaveLength(2);
    expect(filterByTag(run.seen, "request.resolved")).toHaveLength(1);
  });

  it("does not send an answer again when it is not known whether the first arrived", async () => {
    const run = await startBusySession({ "turn/steer": SILENT });
    const requestId = await askAsyncQuestion(run);

    const first = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const delivering = yield* Effect.forkChild(
            Effect.flip(run.adapter.respondToQuestion(SESSION, requestId, { Question: "Yes" })),
          );
          yield* Effect.promise(() =>
            waitUntil(
              "sent the steer",
              () => listSentParams(run.requests, "turn/steer").length === 1,
            ),
          );
          // A second answer while the first is on its way is refused at once.
          const concurrent = yield* Effect.flip(
            run.adapter.respondToQuestion(SESSION, requestId, { Question: "No" }),
          );
          yield* TestClock.adjust(RPC_DEADLINE);
          return { concurrent, failure: yield* Fiber.join(delivering) };
        }),
        TestClock.layer(),
      ),
    );

    expect(first.concurrent.message).toContain("already on its way");
    expect(first.failure.message).toContain("may have reached the agent");
    const retry = await fail(run, requestId, { Question: "Yes" });
    expect(retry.message).toContain("may have reached the agent");
    expect(listSentParams(run.requests, "turn/steer")).toHaveLength(1);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
  });

  it("does not reopen when Codex sends the item again, before or after the answer", async () => {
    const run = await startBusySession();
    const requestId = await askAsyncQuestion(run);
    run.server.push(buildItemNote("item/completed", ASYNC_ITEM));
    await settle();
    expect(filterByTag(run.seen, "request.opened")).toHaveLength(1);

    await answer(run, requestId, { Question: "Yes" });
    run.server.push(buildItemNote("item/completed", ASYNC_ITEM));
    await settle();

    expect(filterByTag(run.seen, "request.opened")).toHaveLength(1);
    // The text reached the stream once, even though the item completed three times.
    expect(filterByTag(run.seen, "content.delta")).toHaveLength(1);
    // The answered Request is gone for good.
    expect((await fail(run, requestId, { Question: "Yes" })).message).toContain("not waiting");
  });

  it("is cancelled when the agent is stopped, busy or idle, and cannot be answered afterwards", async () => {
    const run = await startBusySession();
    const busy = await askAsyncQuestion(run, { ...ASYNC_ITEM, id: "call_busy" });
    const second = await askAsyncQuestion(run, { ...ASYNC_ITEM, id: "call_second" });

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    expect(filterByTag(run.seen, "request.resolved")).toMatchObject([
      { requestId: busy, decision: "cancel" },
      { requestId: second, decision: "cancel" },
    ]);
    expect((await fail(run, busy, { Question: "Yes" })).message).toContain("not waiting");
    run.server.push(buildItemNote("item/completed", { ...ASYNC_ITEM, id: "call_busy" }));
    await settle();
    expect(filterByTag(run.seen, "request.opened")).toHaveLength(2);

    await completeTurn(run);
    const idle = await askAsyncQuestion(run, { ...ASYNC_ITEM, id: "call_idle" });
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(filterByTag(run.seen, "request.resolved").at(-1)).toMatchObject({
      requestId: idle,
      decision: "cancel",
    });
  });

  it("is cancelled once when the agent is stopped while its answer is on its way", async () => {
    const run = await startBusySession({ "turn/steer": SILENT });
    const requestId = await askAsyncQuestion(run);

    const first = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const delivering = yield* Effect.forkChild(
            Effect.flip(run.adapter.respondToQuestion(SESSION, requestId, { Question: "Yes" })),
          );
          yield* Effect.promise(() =>
            waitUntil(
              "sent the steer",
              () => listSentParams(run.requests, "turn/steer").length === 1,
            ),
          );
          yield* run.adapter.interrupt(SESSION);
          yield* TestClock.adjust(RPC_DEADLINE);
          return yield* Fiber.join(delivering);
        }),
        TestClock.layer(),
      ),
    );

    expect(first).toBeInstanceOf(AnswerNotDelivered);
    expect(filterByTag(run.seen, "request.resolved")).toMatchObject([
      { requestId, decision: "cancel" },
    ]);
  });

  it("opens nothing for a subagent's async question and warns the session", async () => {
    const run = await startBusySession({
      "thread/read": (params: unknown) => ({
        thread: {
          id: (params as { threadId: string }).threadId,
          parentThreadId: THREAD,
          model: "m",
          agentRole: null,
          agentNickname: null,
        },
      }),
    });
    const child = "0199e0e7-0000-7000-8000-0000000000b1";
    const push = (server: Spawn): void => {
      server.push({
        method: "turn/started",
        params: {
          threadId: child,
          turn: { id: child, items: [], itemsView: "full", status: "inProgress" },
        },
      });
      server.push(buildItemNote("item/completed", ASYNC_ITEM, child));
    };
    push(run.server);

    await waitUntil("warned", () =>
      filterByTag(run.seen, "runtime.warning").some((event) =>
        event.message.includes("async question"),
      ),
    );
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
  });
});
