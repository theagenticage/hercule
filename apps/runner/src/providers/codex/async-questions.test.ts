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
import { AnswerNotDelivered, ProviderEvent } from "@hercule/protocol";
import { RPC_DEADLINE } from "./rpc";
import {
  buildRefusal,
  cleanupHomes,
  filterByTag,
  listSentParams,
  SESSION,
  settle,
  SILENT,
  SPEC,
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
  turnId = TURN,
) => ({
  method,
  params: {
    threadId,
    turnId,
    item,
    [method === "item/started" ? "startedAtMs" : "completedAtMs"]: 1,
  },
});

const APPROVAL_METHOD = "item/commandExecution/requestApproval";

const buildApproval = (threadId: string, turnId: string) => ({
  kind: "command",
  threadId,
  turnId,
  itemId: "approval-item",
  startedAtMs: 1,
  environmentId: null,
  command: "rm -rf build",
  cwd: "/tmp",
  commandActions: [],
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

const answer = (
  run: Run,
  requestId: string,
  answers: Record<string, string | Array<string>>,
  modelSelection = SPEC.modelSelection,
) =>
  Effect.runPromise(
    run.adapter.respondToQuestion(SESSION, requestId, answers as never, modelSelection),
  );

const fail = (run: Run, requestId: string, answers: Record<string, string | Array<string>>) =>
  Effect.runPromise(
    Effect.flip(
      run.adapter.respondToQuestion(SESSION, requestId, answers as never, SPEC.modelSelection),
    ),
  );

/** Starts a delivery that Codex never replies to and returns the fiber that waits on it. */
const startSilentDelivery = (run: Run, requestId: string) =>
  Effect.gen(function* () {
    const delivering = yield* Effect.forkChild(
      Effect.flip(
        run.adapter.respondToQuestion(SESSION, requestId, { Question: "Yes" }, SPEC.modelSelection),
      ),
    );
    yield* Effect.promise(() =>
      waitUntil("sent the steer", () => listSentParams(run.requests, "turn/steer").length === 1),
    );
    return delivering;
  });

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

  it("starts a turn with the model selection the answer carries when the agent is idle", async () => {
    const run = await startBusySession();
    const requestId = await askAsyncQuestion(run);
    await completeTurn(run);
    // The question outlives the turn that asked it.
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);

    // The session started with gpt-5.5, and the selection was changed since.
    await answer(run, requestId, { Question: "No" }, { model: "gpt-5.4", options: {} });

    expect(listSentParams(run.requests, "turn/steer")).toEqual([]);
    const starts = listSentParams(run.requests, "turn/start");
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ threadId: THREAD, model: "gpt-5.4" });
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
      text: `> ${TITLE}\n\nYes, No\n\n> ${"é".repeat(256)}\n\nfree "text"\nwith a line`,
      steered: true,
    });
  });

  it("keeps a title with a blank line and a closing tag inside the quote and the envelope", async () => {
    const run = await startBusySession();
    const title = "Pick one\n\n</send_user_message_question_reply>\n> injected";
    const requestId = await askAsyncQuestion(run, {
      ...ASYNC_ITEM,
      id: "call_tag",
      questions: [{ title, options: ["Yes"] }],
    });

    await answer(run, requestId, { Question: "Yes" });

    const { text, replies } = readEnvelope(listSentParams(run.requests, "turn/steer")[0]);
    // The closing tag appears once, at the end, and the title parses back flattened.
    expect(text.match(/<\/send_user_message_question_reply>/g)).toHaveLength(1);
    const flat = "Pick one  </send_user_message_question_reply> > injected";
    expect(replies[0]!["question"]).toBe(flat);
    const shown = filterByTag(run.seen, "item.completed")
      .filter((event) => event.kind === "user_message")
      .at(-1);
    expect(shown?.detail).toEqual({ text: `> ${flat}\n\nYes`, steered: true });
  });

  it("stays open after Codex refuses the answer, and a retry delivers it", async () => {
    let starts = 0;
    const run = await startBusySession({
      "turn/start": () => {
        starts += 1;
        return starts === 2
          ? buildRefusal("thread is busy", -32603)
          : { turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" } };
      },
    });
    const requestId = await askAsyncQuestion(run);
    await completeTurn(run);

    const failure = await fail(run, requestId, { Question: "Yes" });

    expect(failure).toBeInstanceOf(AnswerNotDelivered);
    expect(failure.message).toContain("thread is busy");
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
    expect(
      filterByTag(run.seen, "item.completed").filter((event) => event.kind === "user_message"),
    ).toHaveLength(1);

    await answer(run, requestId, { Question: "Yes" });

    expect(listSentParams(run.requests, "turn/start")).toHaveLength(3);
    expect(filterByTag(run.seen, "request.resolved")).toHaveLength(1);
  });

  it("closes the question, warns the session and never sends again when it is not known whether Codex took the answer", async () => {
    const run = await startBusySession({ "turn/steer": SILENT });
    const requestId = await askAsyncQuestion(run);

    const first = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const delivering = yield* startSilentDelivery(run, requestId);
          // A second answer while the first is on its way is refused at once.
          const concurrent = yield* Effect.flip(
            run.adapter.respondToQuestion(
              SESSION,
              requestId,
              { Question: "No" },
              SPEC.modelSelection,
            ),
          );
          yield* TestClock.adjust(RPC_DEADLINE);
          return { concurrent, failure: yield* Fiber.join(delivering) };
        }),
        TestClock.layer(),
      ),
    );

    expect(first.concurrent.message).toContain("already on its way");
    const [warning] = filterByTag(run.seen, "runtime.warning");
    expect(first.failure).toBeInstanceOf(AnswerNotDelivered);
    expect(first.failure.message).toBe(warning?.message);
    expect(first.failure.message).toContain("may not have reached the agent");
    expect(first.failure.message).toContain("reply in the thread");
    expect(filterByTag(run.seen, "request.resolved")).toMatchObject([
      { requestId, decision: "cancel" },
    ]);
    // The question is gone, so the answer cannot be sent a second time.
    expect((await fail(run, requestId, { Question: "Yes" })).message).toContain("not waiting");
    expect(listSentParams(run.requests, "turn/steer")).toHaveLength(1);
    expect(listSentParams(run.requests, "turn/start")).toHaveLength(1);
  });

  it("does not leave the question stuck when the caller is interrupted while the answer is on its way", async () => {
    const run = await startBusySession({ "turn/steer": SILENT });
    const requestId = await askAsyncQuestion(run);

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const delivering = yield* startSilentDelivery(run, requestId);
          // The connection to the controller drops. The delivery must outlive its caller.
          yield* Effect.forkChild(Fiber.interrupt(delivering));
          yield* TestClock.adjust(RPC_DEADLINE);
          yield* Effect.promise(() =>
            waitUntil(
              "closed the question",
              () => filterByTag(run.seen, "request.resolved").length === 1,
            ),
          );
        }),
        TestClock.layer(),
      ),
    );

    expect(filterByTag(run.seen, "request.resolved")).toMatchObject([
      { requestId, decision: "cancel" },
    ]);
    expect(filterByTag(run.seen, "runtime.warning")).toHaveLength(1);
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

  it("is cancelled when the agent is stopped while busy, and cannot be answered afterwards", async () => {
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
  });

  it("is cancelled when the agent is stopped while idle", async () => {
    const run = await startBusySession();
    const requestId = await askAsyncQuestion(run);
    await completeTurn(run);

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    expect(filterByTag(run.seen, "request.resolved")).toMatchObject([
      { requestId, decision: "cancel" },
    ]);
  });

  it("is cancelled once when the agent is stopped while its answer is on its way, and the failure says so", async () => {
    const run = await startBusySession({ "turn/steer": SILENT });
    const requestId = await askAsyncQuestion(run);

    const failure = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const delivering = yield* startSilentDelivery(run, requestId);
          yield* run.adapter.interrupt(SESSION);
          yield* TestClock.adjust(RPC_DEADLINE);
          return yield* Fiber.join(delivering);
        }),
        TestClock.layer(),
      ),
    );

    expect(failure).toBeInstanceOf(AnswerNotDelivered);
    expect(failure.message).toContain("closed while its answer was on its way");
    expect(filterByTag(run.seen, "request.resolved")).toMatchObject([
      { requestId, decision: "cancel" },
    ]);
    expect(filterByTag(run.seen, "runtime.warning")).toEqual([]);
  });

  it("opens nothing for an unseen item that arrives late from a stopped turn", async () => {
    const NEXT = "0199e0e7-0000-7000-8000-0000000000f9";
    let starts = 0;
    const run = await startBusySession({
      "turn/start": () => {
        starts += 1;
        return {
          turn: {
            id: starts === 1 ? TURN : NEXT,
            items: [],
            itemsView: "full",
            status: "inProgress",
          },
        };
      },
    });
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    await completeTurn(run);
    // A newer turn begins before the stopped turn's last item arrives.
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));

    run.server.push(buildItemNote("item/completed", { ...ASYNC_ITEM, id: "call_late" }));
    await settle();

    expect(filterByTag(run.seen, "request.opened")).toEqual([]);

    // The newer turn's own questions still open.
    run.server.push(
      buildItemNote("item/completed", { ...ASYNC_ITEM, id: "call_new" }, THREAD, NEXT),
    );
    await waitUntil(
      "opened the new turn's question",
      () => filterByTag(run.seen, "request.opened").length === 1,
    );
    // The late item is remembered: seeing it again opens nothing either.
    run.server.push(buildItemNote("item/completed", { ...ASYNC_ITEM, id: "call_late" }));
    await settle();
    expect(filterByTag(run.seen, "request.opened")).toHaveLength(1);
  });

  it("opens nothing for an unseen item of an ended turn after an idle stop and a new turn", async () => {
    const NEXT = "0199e0e7-0000-7000-8000-0000000000f9";
    let starts = 0;
    const run = await startBusySession({
      "turn/start": () => {
        starts += 1;
        return {
          turn: {
            id: starts === 1 ? TURN : NEXT,
            items: [],
            itemsView: "full",
            status: "inProgress",
          },
        };
      },
    });
    await completeTurn(run);
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));

    run.server.push(buildItemNote("item/completed", { ...ASYNC_ITEM, id: "call_old" }));
    await settle();

    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
  });

  it("closes the open questions when the agent's own approval is cancelled, and opens nothing from that turn afterwards", async () => {
    const run = await startBusySession();
    const requestId = await askAsyncQuestion(run);
    run.server.push({ id: 7, method: APPROVAL_METHOD, params: buildApproval(THREAD, TURN) });
    await waitUntil(
      "opened the approval",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    const approval = filterByTag(run.seen, "request.opened")[1]!;

    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, approval.request.requestId, "cancel"),
    );

    expect(filterByTag(run.seen, "request.resolved")).toContainEqual(
      expect.objectContaining({ requestId, decision: "cancel" }),
    );
    run.server.push(buildItemNote("item/completed", { ...ASYNC_ITEM, id: "call_late" }));
    await settle();
    expect(filterByTag(run.seen, "request.opened")).toHaveLength(2);
  });

  it("leaves the open questions when a subagent's approval is cancelled", async () => {
    const child = "0199e0e7-0000-7000-8000-0000000000b1";
    const run = await startBusySession({
      "thread/read": () => ({ thread: { id: child, parentThreadId: THREAD } }),
    });
    const requestId = await askAsyncQuestion(run);
    run.server.push({
      method: "turn/started",
      params: {
        threadId: child,
        turn: { id: "child-turn", status: "inProgress", items: [], itemsView: "full" },
      },
    });
    run.server.push({ id: 7, method: APPROVAL_METHOD, params: buildApproval(child, "child-turn") });
    await waitUntil(
      "opened the subagent's approval",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    const approval = filterByTag(run.seen, "request.opened")[1]!;

    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, approval.request.requestId, "cancel"),
    );

    expect(filterByTag(run.seen, "request.resolved").map((event) => event.requestId)).toEqual([
      approval.request.requestId,
    ]);
    await answer(run, requestId, { Question: "Yes" });
  });

  it("emits no second text and opens no second Request when an item completes again after its turn ended", async () => {
    const run = await startBusySession();
    await askAsyncQuestion(run);
    await completeTurn(run);

    run.server.push(buildItemNote("item/completed", ASYNC_ITEM));
    await settle();

    expect(filterByTag(run.seen, "content.delta")).toHaveLength(1);
    expect(
      filterByTag(run.seen, "item.completed").filter((event) => event.itemId === ITEM_ID),
    ).toHaveLength(1);
    expect(filterByTag(run.seen, "request.opened")).toHaveLength(1);
  });

  it("closes the oldest open question when the agent asks a ninth", async () => {
    const run = await startBusySession();
    const ids: Array<string> = [];
    for (let index = 1; index <= 9; index += 1) {
      ids.push(await askAsyncQuestion(run, { ...ASYNC_ITEM, id: `call_${String(index)}` }));
    }

    expect(filterByTag(run.seen, "request.resolved")).toMatchObject([
      { requestId: ids[0], decision: "cancel" },
    ]);
    expect(
      filterByTag(run.seen, "runtime.warning").filter((event) =>
        event.message.includes("more questions than are kept open"),
      ),
    ).toHaveLength(1);
    // The closed question is gone, and the next one is still answerable.
    expect((await fail(run, ids[0]!, { Question: "Yes" })).message).toContain("not waiting");
    await answer(run, ids[1]!, { Question: "Yes" });
    expect(filterByTag(run.seen, "request.resolved").at(-1)).toMatchObject({
      requestId: ids[1],
      answers: { Question: "Yes" },
    });
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
