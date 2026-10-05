/** Drives interleaved Codex threads through the adapter's public interface. */
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Schema, Stream } from "effect";
import { makeCodexAdapter } from "./adapter";
import { ProviderEvent } from "@hercule/protocol";
import {
  buildContext,
  buildScriptedSeam,
  cleanupHomes,
  createCodexHome,
  createDriving,
  filterByTag,
  listSentParams,
  SESSION,
  settle,
  SPEC,
  startBusySession,
  startTestSession,
  THREAD,
  TURN,
  waitUntil,
  type Answered,
  type Spawn,
} from "./testing";

afterAll(cleanupHomes);

const CHILD_A = "0199e0e7-0000-7000-8000-0000000000a1";
const CHILD_B = "0199e0e7-0000-7000-8000-0000000000b1";
const SECOND_SESSION = "0199e0e7-0000-7000-8000-0000000000d1";

/** Returns the metadata-only reply for a child, without loading its history. */
const readThreadMetadata = (params: unknown): unknown => {
  const { threadId } = params as { readonly threadId: string };
  return {
    thread: {
      id: threadId,
      parentThreadId: THREAD,
      agentNickname: threadId === CHILD_A ? "Ada" : "Grace",
      agentRole: "explorer",
      model: "child-model",
      turns: [],
    },
  };
};

/** Holds metadata replies until the test releases them, while all other RPCs run normally. */
const createDelayedMetadataSession = async () => {
  const scripted = buildScriptedSeam({ "thread/read": readThreadMetadata });
  const pendingReads: Array<() => void> = [];
  const repliesByHost: Array<Array<Answered>> = [];
  const adapter = makeCodexAdapter({
    ...scripted.seam,
    appServer: (command, env) => {
      const child = scripted.seam.appServer(command, env);
      const replies: Array<Answered> = [];
      repliesByHost.push(replies);
      return {
        ...child,
        write: (text) => {
          const frame = JSON.parse(text) as Answered & { readonly method?: string };
          if (frame.method === undefined && frame.id !== undefined) replies.push(frame);
          if (frame.method === "thread/read") pendingReads.push(() => child.write(text));
          else child.write(text);
        },
      };
    },
  });
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
  );
  await Effect.runPromise(
    adapter.startSession(SESSION, SPEC, buildContext(createCodexHome(), "/tmp/work")),
  );
  return { ...scripted, adapter, seen, server: scripted.spawns[0]!, pendingReads, repliesByHost };
};

const startTurn = (server: Spawn, threadId: string, turnId = threadId): void =>
  server.push({
    method: "turn/started",
    params: { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "inProgress" } },
  });

const completeTurn = (server: Spawn, threadId: string, turnId = threadId): void =>
  server.push({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "completed" } },
  });

const requestCommand = (server: Spawn, threadId: string, id: string | number): void =>
  server.push({
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId,
      turnId: threadId,
      itemId: "same-item-id",
      command: `echo ${threadId}`,
      cwd: "/tmp/work",
      commandActions: [],
      environmentId: null,
    },
  });

const validateEvents = (seen: ReadonlyArray<ProviderEvent>): void => {
  for (const event of seen)
    expect(Schema.is(ProviderEvent)(event), JSON.stringify(event)).toBe(true);
};

describe("independent Codex subagent conversations", () => {
  it("keeps reasoning channels, completion and the root's structured answer separate", async () => {
    const run = createDriving({ "thread/read": readThreadMetadata });
    await Effect.runPromise(
      run.adapter.startSession(
        SESSION,
        {
          ...SPEC,
          outputSchema: {
            type: "object",
            properties: { verdict: { type: "string", enum: ["accept"] } },
            required: ["verdict"],
            additionalProperties: false,
          },
        },
        run.ctx,
      ),
    );
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess the change." }));
    const server = run.spawns[0]!;
    startTurn(server, THREAD, TURN);
    startTurn(server, CHILD_A);
    startTurn(server, CHILD_B);
    await waitUntil(
      "introduced both children",
      () => filterByTag(run.seen, "subagent.started").length === 2,
    );

    const reason = (threadId: string, method: string, delta: string): void =>
      server.push({
        method,
        params: {
          threadId,
          turnId: threadId === THREAD ? TURN : threadId,
          itemId: "shared-reasoning-id",
          delta,
        },
      });
    reason(THREAD, "item/reasoning/textDelta", "root reasoning");
    reason(CHILD_A, "item/reasoning/summaryTextDelta", "A reasoning");
    reason(CHILD_B, "item/reasoning/summaryTextDelta", "B reasoning");
    completeTurn(server, CHILD_A);
    server.push({
      method: "item/completed",
      params: {
        threadId: CHILD_B,
        turnId: CHILD_B,
        item: { type: "agentMessage", id: "child-answer", text: "Plain prose from the child." },
      },
    });
    completeTurn(server, CHILD_B);
    await waitUntil(
      "completed both children",
      () => filterByTag(run.seen, "turn.completed").length === 2,
    );

    expect(
      filterByTag(run.seen, "content.delta").map((event) => [event.subagentId, event.delta]),
    ).toEqual([
      [undefined, "root reasoning"],
      [CHILD_A, "A reasoning"],
      [CHILD_B, "B reasoning"],
    ]);
    for (const event of filterByTag(run.seen, "turn.completed")) {
      expect(event.subagentId).toBeDefined();
      expect(event.structuredResult).toBeUndefined();
    }
    const delivery = await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "Keep going." }),
    );
    expect(delivery.delivery).toBe("steered");
    server.push({
      method: "item/completed",
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: { type: "agentMessage", id: "root-answer", text: '{"verdict":"accept"}' },
      },
    });
    completeTurn(server, THREAD, TURN);
    await waitUntil(
      "completed the root",
      () => filterByTag(run.seen, "turn.completed").length === 3,
    );
    expect(filterByTag(run.seen, "turn.completed")[2]).toMatchObject({
      structuredResult: { outcome: "ok", value: { verdict: "accept" } },
    });
    expect(await Effect.runPromise(run.adapter.listSessions)).toHaveLength(1);
    validateEvents(run.seen);
  });

  it("opens both children's approvals immediately and answers the second first", async () => {
    const run = await startBusySession({ "thread/read": readThreadMetadata });
    startTurn(run.server, CHILD_A);
    startTurn(run.server, CHILD_B);
    requestCommand(run.server, CHILD_A, 71);
    requestCommand(run.server, CHILD_B, "72");
    await waitUntil(
      "opened both approvals",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    const [first, second] = filterByTag(run.seen, "request.opened");
    expect([first?.subagentId, second?.subagentId]).toEqual([CHILD_A, CHILD_B]);
    expect(first?.request.requestId).not.toBe(second?.request.requestId);
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, second!.request.requestId, "deny"),
    );
    expect(run.answered).toEqual([{ id: "72", result: { decision: "decline" } }]);
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, first!.request.requestId, "allow"),
    );
    expect(run.answered).toEqual([
      { id: "72", result: { decision: "decline" } },
      { id: 71, result: { decision: "accept" } },
    ]);
    await waitUntil(
      "resolved both approvals",
      () => filterByTag(run.seen, "request.resolved").length === 2,
    );
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.subagentId)).toEqual([
      CHILD_B,
      CHILD_A,
    ]);
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([]);
    validateEvents(run.seen);
  });

  it("cancels a completed child's requests without cancelling its sibling's request", async () => {
    const run = await startBusySession({ "thread/read": readThreadMetadata });
    startTurn(run.server, CHILD_A);
    startTurn(run.server, CHILD_B);
    requestCommand(run.server, CHILD_A, 81);
    requestCommand(run.server, CHILD_B, 82);
    await waitUntil(
      "opened both requests",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    completeTurn(run.server, CHILD_A);
    await waitUntil("cancelled the completed child's request", () => run.answered.length === 1);
    expect(run.answered).toEqual([{ id: 81, result: { decision: "cancel" } }]);
    const sibling = filterByTag(run.seen, "request.opened").find(
      (event) => event.subagentId === CHILD_B,
    )!;
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, sibling.request.requestId, "allow"),
    );
    expect(run.answered[1]).toEqual({ id: 82, result: { decision: "accept" } });
    const delivery = await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "Continue the root." }),
    );
    expect(delivery.delivery).toBe("steered");
  });

  it("replays queued notifications and Requests in order after metadata discovery", async () => {
    const run = await createDelayedMetadataSession();
    startTurn(run.server, CHILD_A);
    run.server.push({
      method: "item/started",
      params: {
        threadId: CHILD_A,
        turnId: CHILD_A,
        item: {
          type: "fileChange",
          id: "queued-change",
          status: "inProgress",
          changes: [{ path: "/tmp/work/queued.ts", kind: "update", diff: "" }],
        },
      },
    });
    run.server.push({
      id: 91,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: CHILD_A,
        turnId: CHILD_A,
        itemId: "queued-change",
        reason: null,
        grantRoot: null,
      },
    });
    completeTurn(run.server, CHILD_A);
    await waitUntil("requested the child metadata", () => run.pendingReads.length === 1);
    await settle();
    expect(filterByTag(run.seen, "subagent.started")).toEqual([]);
    expect(filterByTag(run.seen, "request.opened")).toEqual([]);
    expect(run.answered).toEqual([]);
    run.pendingReads[0]!();
    await waitUntil(
      "replayed the completion",
      () => filterByTag(run.seen, "turn.completed").length === 1,
    );
    const childEvents = run.seen.filter(
      (event) => "subagentId" in event && event.subagentId === CHILD_A,
    );
    expect(childEvents.map((event) => event._tag)).toEqual([
      "subagent.started",
      "turn.started",
      "item.started",
      "request.opened",
      "turn.completed",
    ]);
    expect(filterByTag(run.seen, "request.opened")[0]?.request.detail).toEqual({
      paths: ["/tmp/work/queued.ts"],
    });
    expect(run.answered).toEqual([{ id: 91, result: { decision: "cancel" } }]);
    expect(listSentParams(run.requests, "thread/read")).toEqual([
      { threadId: CHILD_A, includeTurns: false },
    ]);
    validateEvents(run.seen);
  });

  it("allows new root and child approvals after explicit user input resumes a stopped idle session", async () => {
    const run = await startTestSession({ "thread/read": readThreadMetadata });
    startTurn(run.server, CHILD_A);
    await waitUntil(
      "started the background child",
      () => filterByTag(run.seen, "turn.started").length === 1,
    );
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    run.server.push({
      method: "turn/completed",
      params: {
        threadId: CHILD_A,
        turn: { id: CHILD_A, items: [], itemsView: "full", status: "interrupted" },
      },
    });
    await waitUntil(
      "stopped the background child",
      () => filterByTag(run.seen, "turn.completed").length === 1,
    );
    const sent = await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "Continue with another agent." }),
    );
    expect(sent.delivery).toBe("opened");
    startTurn(run.server, THREAD, TURN);
    startTurn(run.server, CHILD_B);
    requestCommand(run.server, THREAD, 111);
    requestCommand(run.server, CHILD_B, 112);
    await waitUntil(
      "opened the resumed approvals",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    await settle();
    expect(run.answered).toEqual([]);
    expect(filterByTag(run.seen, "request.resolved")).toEqual([]);
    expect(listSentParams(run.requests, "turn/interrupt")).toEqual([
      { threadId: CHILD_A, turnId: CHILD_A },
    ]);
    for (const event of filterByTag(run.seen, "request.opened")) {
      await Effect.runPromise(
        run.adapter.respondToApprovalRequest(SESSION, event.request.requestId, "allow"),
      );
    }
    expect(run.answered).toEqual([
      { id: 111, result: { decision: "accept" } },
      { id: 112, result: { decision: "accept" } },
    ]);
    validateEvents(run.seen);
  });

  it("adds each child's new usage to the session without charging inherited history twice", async () => {
    const run = await startBusySession({ "thread/read": readThreadMetadata });
    const report = (
      threadId: string,
      total: readonly [number, number, number, number],
      last: readonly [number, number, number, number],
    ): void => {
      const counts = ([input, cached, writes, output]: readonly [
        number,
        number,
        number,
        number,
      ]) => ({
        inputTokens: input,
        cachedInputTokens: cached,
        cacheWriteInputTokens: writes,
        outputTokens: output,
        totalTokens: input + writes + output,
        reasoningOutputTokens: 0,
      });
      run.server.push({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId: threadId === THREAD ? TURN : threadId,
          tokenUsage: { total: counts(total), last: counts(last), modelContextWindow: 272000 },
        },
      });
    };
    report(THREAD, [1000, 200, 20, 100], [1000, 200, 20, 100]);
    // Both children inherit the root's history before their own turns start.
    report(CHILD_A, [1000, 200, 20, 100], [1000, 200, 20, 100]);
    report(CHILD_B, [1000, 200, 20, 100], [1000, 200, 20, 100]);
    startTurn(run.server, CHILD_A);
    startTurn(run.server, CHILD_B);
    // Codex repeats inherited totals after a cancelled call. This adds zero.
    report(CHILD_A, [1000, 200, 20, 100], [1000, 200, 20, 100]);
    report(CHILD_B, [1000, 200, 20, 100], [1000, 200, 20, 100]);
    report(CHILD_A, [1500, 300, 25, 150], [500, 100, 5, 50]);
    report(CHILD_B, [1700, 500, 27, 170], [700, 300, 7, 70]);
    await waitUntil(
      "reported the final usage",
      () => filterByTag(run.seen, "session.usage.updated").length === 9,
    );
    const snapshots = filterByTag(run.seen, "session.usage.updated");
    expect(
      snapshots.filter((event) => event.subagentId === CHILD_A).map((event) => event.usage),
    ).toEqual([
      { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      { inputTokens: 400, cacheReadTokens: 100, cacheWriteTokens: 5, outputTokens: 50 },
    ]);
    expect(
      snapshots.filter((event) => event.subagentId === CHILD_B).map((event) => event.usage),
    ).toEqual([
      { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      { inputTokens: 400, cacheReadTokens: 300, cacheWriteTokens: 7, outputTokens: 70 },
    ]);
    expect(snapshots.at(-1)).toMatchObject({
      usage: {
        inputTokens: 1600,
        cacheReadTokens: 600,
        cacheWriteTokens: 32,
        outputTokens: 220,
      },
    });
    expect(snapshots.at(-1)?.subagentId).toBeUndefined();
    validateEvents(run.seen);
  });

  it("scopes identical child and vendor request IDs to their app-server session", async () => {
    const run = await createDelayedMetadataSession();
    await Effect.runPromise(
      run.adapter.startSession(SECOND_SESSION, SPEC, buildContext(createCodexHome(), "/tmp/work")),
    );
    for (const server of run.spawns) {
      startTurn(server, CHILD_A);
      requestCommand(server, CHILD_A, 101);
    }
    await waitUntil("requested each host's metadata", () => run.pendingReads.length === 2);
    for (const reply of run.pendingReads) reply();
    await waitUntil(
      "opened one approval in each session",
      () => filterByTag(run.seen, "request.opened").length === 2,
    );
    const first = filterByTag(run.seen, "request.opened").find(
      (event) => event.sessionId === SESSION,
    )!;
    const second = filterByTag(run.seen, "request.opened").find(
      (event) => event.sessionId === SECOND_SESSION,
    )!;
    expect(first.request.requestId).not.toBe(second.request.requestId);
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, second.request.requestId, "allow"),
    );
    expect(run.answered).toEqual([]);
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SECOND_SESSION, second.request.requestId, "deny"),
    );
    await Effect.runPromise(
      run.adapter.respondToApprovalRequest(SESSION, first.request.requestId, "allow"),
    );
    expect(run.answered).toEqual([
      { id: 101, result: { decision: "decline" } },
      { id: 101, result: { decision: "accept" } },
    ]);
    expect(run.repliesByHost).toEqual([
      [{ id: 101, result: { decision: "accept" } }],
      [{ id: 101, result: { decision: "decline" } }],
    ]);
    await settle();
    expect(filterByTag(run.seen, "request.resolved").map((event) => event.sessionId)).toEqual([
      SECOND_SESSION,
      SESSION,
    ]);
    validateEvents(run.seen);
  });
});
