/**
 * Tests subagents against the real pi binary. pi has no subagents of its own:
 * Hercule's extension gives a session a `subagent` tool, and the runner starts
 * a child pi process for each call (spec 06 section 13.6). Only the real binary
 * proves that the tool is registered, that its call reaches the runner, that
 * several children run and ask for approvals at the same time, and that
 * stopping a child really stops its process and lets its parent carry on.
 *
 * As in the park test, no paid key and no real model are used. `models.json`
 * in a throwaway agent directory points pi at a local fake model server. The
 * session and its children all ask that one server, in no fixed order, so the
 * script below chooses each reply by the conversation in the request: the
 * first user message tells which agent is asking, and a trailing tool result
 * tells how far that agent has got.
 *
 * Skips without `pi` on PATH, like the other integration tests here.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { ProviderEvent, SessionSpec } from "@hercule/protocol";
import { pi } from "./adapter";
import { SUBAGENT_TOOL } from "./extension";
import { cleanupHomes, buildContext, TEST_ZAI_KEY, SPEC, filterByTag, waitUntil } from "./testing";
import { createScratchHome } from "../testing";
import {
  endsWithToolResult,
  pointAtFakeModel,
  readFirstUserText,
  readRequestMessageText,
  startScriptedModelServer,
  type FakeModelReply,
  type FakeModelRequest,
  type FakeModelServer,
  type FakeToolCall,
} from "./upstream";

const binary = Bun.which("pi") ?? undefined;

const upstreams: Array<FakeModelServer> = [];

/** Sessions still running, so a test that fails half way still has its pi processes stopped. */
const running = new Set<Live>();

afterAll(async () => {
  for (const live of running) await live.stop().catch(() => undefined);
  cleanupHomes();
  for (const upstream of upstreams.splice(0)) upstream.stop();
});

const createScratchDir = (): string => createScratchHome("pi-subagents");

/** Several pi processes start and ask the model here, so each test gets a generous budget. */
const BUDGET_MS = 180_000;

/** The budget for one wait, so a test that times out on one step still has time to report. */
const STEP_MS = BUDGET_MS / 3;

/**
 * Long enough that a command that was going to run without an answer would
 * have run. Short, because once both requests are open each child's pi is
 * already blocked in the approval hook, before the command.
 */
const UNANSWERED_MS = 300;

const SPEC_UNDER_TEST: SessionSpec = {
  ...SPEC,
  modelSelection: { model: "fake-model", options: { thinking: "low" } },
  accessMode: "approval-required",
};

/**
 * One agent the fake model plays. `input` is the agent's first user message:
 * the session's input for the main agent, or the brief its parent gave it for
 * a subagent. `act` is the agent's first reply, `finish` its reply once a tool
 * result arrives, and `promptTokens` the usage every reply of this agent
 * reports. Each agent reports a different count, so a sum that counted one
 * agent twice, or left one out, comes out wrong.
 */
interface ScriptedAgent {
  readonly input: string;
  readonly act: ReadonlyArray<FakeToolCall>;
  readonly finish: string;
  readonly promptTokens: number;
}

/** What the fake model saw: every request, with the agent it was for. */
interface ModelRequestLog {
  readonly requests: Array<{ readonly agent: string; readonly request: FakeModelRequest }>;
  /** Requests whose first user message matched no scripted agent. */
  readonly unscripted: Array<string>;
}

/**
 * Builds a server script from the agents the test scripts. Returns the script
 * and the log of model requests it records into. A request from no scripted agent is
 * answered with text, and recorded so the test can fail on it.
 */
const buildScript = (
  agents: ReadonlyArray<ScriptedAgent>,
): {
  readonly script: (request: FakeModelRequest) => FakeModelReply;
  readonly requestLog: ModelRequestLog;
} => {
  const requestLog: ModelRequestLog = { requests: [], unscripted: [] };
  const script = (request: FakeModelRequest): FakeModelReply => {
    const input = readFirstUserText(request);
    const agent = agents.find((candidate) => candidate.input === input);
    if (agent === undefined) {
      requestLog.unscripted.push(input);
      return { text: "This conversation is not in the test's script." };
    }
    requestLog.requests.push({ agent: agent.input, request });
    const usage = { promptTokens: agent.promptTokens, completionTokens: 1 };
    return endsWithToolResult(request)
      ? { text: agent.finish, usage }
      : { toolCalls: agent.act, usage };
  };
  return { script, requestLog };
};

/** Builds the call that starts one subagent. */
const callSubagent = (description: string, prompt: string): FakeToolCall => ({
  name: SUBAGENT_TOOL,
  args: { description, prompt },
});

/** Builds a shell call that writes a marker file, so the test can tell the command really ran. */
const callBash = (marker: string): FakeToolCall => ({
  name: "bash",
  args: { command: `echo ran > ${marker}` },
});

interface Live {
  readonly sessionId: string;
  readonly seen: Array<ProviderEvent>;
  readonly requestLog: ModelRequestLog;
  readonly upstream: FakeModelServer;
  readonly stop: () => Promise<void>;
}

/**
 * Starts a real pi session on a fake model that plays the given agents, and
 * sends the main agent's input. The first agent is the main agent.
 */
const startLiveSession = async (agents: ReadonlyArray<ScriptedAgent>): Promise<Live> => {
  const { script, requestLog } = buildScript(agents);
  const upstream = startScriptedModelServer(script);
  upstreams.push(upstream);
  const home = createScratchDir();
  pointAtFakeModel(home, upstream.baseUrl);
  const cwd = createScratchDir();
  // The fake server checks no key. The real PATH is passed so pi can find
  // the shell it runs commands with.
  const ctx = {
    ...buildContext(home, cwd, { zaiApiKey: TEST_ZAI_KEY }),
    binary: binary!,
    env: { PATH: process.env["PATH"] ?? "" },
  };
  const sessionId = crypto.randomUUID();
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(pi.events, (event) =>
      Effect.sync(() => {
        if (event.sessionId === sessionId) seen.push(event);
      }),
    ),
  );
  await Effect.runPromise(pi.startSession(sessionId, SPEC_UNDER_TEST, ctx));
  const live: Live = {
    sessionId,
    seen,
    requestLog,
    upstream,
    stop: async () => {
      running.delete(live);
      await Effect.runPromise(pi.stopSession(sessionId, "stopped"));
    },
  };
  running.add(live);
  await Effect.runPromise(pi.sendInput(sessionId, { text: agents[0]!.input }));
  return live;
};

/** Lists the events the session has reported, each with the subagent it belongs to. */
const describeProgress = (live: Live): string => {
  const events = live.seen
    .map((event) =>
      "subagentId" in event && event._tag !== "subagent.started"
        ? `${event._tag}@${event.subagentId}`
        : event._tag,
    )
    .join(", ");
  const unscripted =
    live.requestLog.unscripted.length === 0
      ? ""
      : `; unscripted model requests from ${live.requestLog.unscripted.join(" | ")}`;
  return `reported ${events}, after ${live.upstream.asked()} model requests${unscripted}`;
};

/**
 * Waits for `ready`, and fails the test when `STEP_MS` runs out. The failure
 * lists what the session had reported by then.
 */
const waitReportingEvents = (live: Live, what: string, ready: () => boolean): Promise<void> =>
  waitUntil(() => `${what}, having ${describeProgress(live)}`, ready, STEP_MS);

type EventWithTag<Tag extends ProviderEvent["_tag"]> = Extract<ProviderEvent, { _tag: Tag }>;

/** Returns the subagent the parent started with the given description, once it has started. */
const findSubagent = (
  live: Live,
  description: string,
): EventWithTag<"subagent.started"> | undefined =>
  filterByTag(live.seen, "subagent.started").find((event) => event.description === description);

/** Returns the events an agent caused: a subagent's, or the main agent's when `subagentId` is absent. */
const filterEventsByAgent = (
  live: Live,
  subagentId: string | undefined,
): ReadonlyArray<ProviderEvent> =>
  live.seen.filter(
    (event) =>
      event._tag !== "subagent.started" &&
      event._tag !== "session.started" &&
      event._tag !== "session.exited" &&
      ("subagentId" in event ? event.subagentId : undefined) === subagentId,
  );

const listOpenedRequests = (
  live: Live,
  subagentId: string | undefined,
): ReadonlyArray<EventWithTag<"request.opened">> =>
  filterByTag(filterEventsByAgent(live, subagentId), "request.opened");

const findResolution = (
  live: Live,
  requestId: string,
): EventWithTag<"request.resolved"> | undefined =>
  filterByTag(live.seen, "request.resolved").find((event) => event.requestId === requestId);

const findTurnEnd = (
  live: Live,
  subagentId: string | undefined,
): EventWithTag<"turn.completed"> | undefined =>
  filterByTag(filterEventsByAgent(live, subagentId), "turn.completed")[0];

/** Returns the `item.completed` of the main agent's call that started the given subagent. */
const findSubagentCallEnd = (
  live: Live,
  started: EventWithTag<"subagent.started">,
): EventWithTag<"item.completed"> | undefined =>
  filterByTag(live.seen, "item.completed").find((event) => event.itemId === started.itemId);

/** Returns the latest token count an agent reported: a subagent's own, or the session's sum. */
const readLatestUsage = (
  live: Live,
  subagentId: string | undefined,
): EventWithTag<"session.usage.updated">["usage"] | undefined =>
  filterByTag(filterEventsByAgent(live, subagentId), "session.usage.updated").at(-1)?.usage;

/** Returns the text of the tool results the agent with the given input was sent. */
const readToolResults = (live: Live, input: string): ReadonlyArray<string> =>
  live.requestLog.requests
    .filter((entry) => entry.agent === input)
    .flatMap((entry) => entry.request.messages.filter((message) => message.role === "tool"))
    .map(readRequestMessageText);

const MAIN_TWO = "Start two subagents, one per half of the work.";

const BRIEF_A = "You are child A. Run one shell command.";

const BRIEF_B = "You are child B. Run one shell command.";

/** Scripts a main agent that starts two subagents in one message, each of which runs a command. */
const scriptTwoChildren = (markerA: string, markerB: string): ReadonlyArray<ScriptedAgent> => [
  {
    input: MAIN_TWO,
    act: [callSubagent("child A", BRIEF_A), callSubagent("child B", BRIEF_B)],
    finish: "Both children are done.",
    promptTokens: 100,
  },
  { input: BRIEF_A, act: [callBash(markerA)], finish: "Child A is done.", promptTokens: 10 },
  { input: BRIEF_B, act: [callBash(markerB)], finish: "Child B is done.", promptTokens: 1 },
];

/** Starts the two-children session and waits until both children are parked on their command. */
const startTwoParkedChildren = async (): Promise<{
  readonly live: Live;
  readonly markerA: string;
  readonly markerB: string;
  readonly childA: EventWithTag<"subagent.started">;
  readonly childB: EventWithTag<"subagent.started">;
  readonly requestA: EventWithTag<"request.opened">;
  readonly requestB: EventWithTag<"request.opened">;
}> => {
  const markerA = join(createScratchDir(), "a-ran");
  const markerB = join(createScratchDir(), "b-ran");
  const live = await startLiveSession(scriptTwoChildren(markerA, markerB));
  await waitReportingEvents(
    live,
    "started both subagents",
    () =>
      findSubagent(live, "child A") !== undefined && findSubagent(live, "child B") !== undefined,
  );
  const childA = findSubagent(live, "child A")!;
  const childB = findSubagent(live, "child B")!;
  await waitReportingEvents(
    live,
    "parked both subagents on their command",
    () =>
      listOpenedRequests(live, childA.subagentId).length === 1 &&
      listOpenedRequests(live, childB.subagentId).length === 1,
  );
  return {
    live,
    markerA,
    markerB,
    childA,
    childB,
    requestA: listOpenedRequests(live, childA.subagentId)[0]!,
    requestB: listOpenedRequests(live, childB.subagentId)[0]!,
  };
};

describe.skipIf(binary === undefined)("a real pi session with subagents", () => {
  it.each([
    { order: "B then A", answerFirst: "B" },
    { order: "A then B", answerFirst: "A" },
  ] as const)(
    "runs two subagents side by side, each with its own approval, answered $order",
    async ({ answerFirst }) => {
      const { live, markerA, markerB, childA, childB, requestA, requestB } =
        await startTwoParkedChildren();

      // Each child is introduced by the main agent's `subagent` call.
      for (const child of [childA, childB]) {
        expect(child.parentSubagentId).toBeUndefined();
        const call = filterByTag(filterEventsByAgent(live, undefined), "item.started").find(
          (event) => event.itemId === child.itemId,
        );
        expect(call?.kind, "the subagent has no subagent item in the main transcript").toBe(
          SUBAGENT_TOOL,
        );
      }
      expect(childA.subagentId).not.toBe(childB.subagentId);
      expect(filterByTag(live.seen, "subagent.started")).toHaveLength(2);

      // Each child's turn opens with its brief.
      for (const [child, brief] of [
        [childA, BRIEF_A],
        [childB, BRIEF_B],
      ] as const) {
        const message = filterByTag(
          filterEventsByAgent(live, child.subagentId),
          "item.started",
        ).find((event) => event.kind === "user_message");
        expect((message?.detail as { readonly text?: string } | undefined)?.text).toBe(brief);
      }

      // Both approvals are open at once: neither waits for the other.
      expect(requestA.request.kind).toBe("command_approval");
      expect(requestB.request.kind).toBe("command_approval");
      expect(requestA.request.requestId).not.toBe(requestB.request.requestId);
      expect(findResolution(live, requestA.request.requestId)).toBeUndefined();
      expect(findResolution(live, requestB.request.requestId)).toBeUndefined();
      // The `subagent` call itself never asks: the only requests are the children's.
      expect(filterByTag(live.seen, "request.opened")).toHaveLength(2);
      // Nothing runs while the approvals are open.
      await new Promise((resolve) => setTimeout(resolve, UNANSWERED_MS));
      expect(existsSync(markerA) || existsSync(markerB), "a command ran without an answer").toBe(
        false,
      );
      expect(findTurnEnd(live, undefined), "the main turn ended before its children").toBe(
        undefined,
      );

      const [first, second] = answerFirst === "B" ? [requestB, requestA] : [requestA, requestB];
      await Effect.runPromise(
        pi.respondToApprovalRequest(live.sessionId, first.request.requestId, "allow"),
      );
      await waitReportingEvents(live, "ran the first allowed command", () =>
        existsSync(answerFirst === "B" ? markerB : markerA),
      );
      // Answering one child does not answer the other.
      expect(findResolution(live, second.request.requestId)).toBeUndefined();
      await Effect.runPromise(
        pi.respondToApprovalRequest(live.sessionId, second.request.requestId, "allow"),
      );
      await waitReportingEvents(live, "ran the second allowed command", () =>
        existsSync(answerFirst === "B" ? markerA : markerB),
      );

      // Each resolution belongs to the child that asked.
      expect(findResolution(live, requestA.request.requestId)?.subagentId).toBe(childA.subagentId);
      expect(findResolution(live, requestB.request.requestId)?.subagentId).toBe(childB.subagentId);

      await waitReportingEvents(
        live,
        "ended both subagents and then the main turn",
        () =>
          findTurnEnd(live, childA.subagentId) !== undefined &&
          findTurnEnd(live, childB.subagentId) !== undefined &&
          findTurnEnd(live, undefined) !== undefined,
      );
      expect(findTurnEnd(live, childA.subagentId)?.state).toBe("completed");
      expect(findTurnEnd(live, childB.subagentId)?.state).toBe("completed");
      const mainEnd = findTurnEnd(live, undefined)!;
      expect(mainEnd.state).toBe("completed");
      expect("subagentId" in mainEnd).toBe(false);
      // The main turn ends after both of its children.
      const indexOf = (event: ProviderEvent | undefined): number =>
        event === undefined ? -1 : live.seen.indexOf(event);
      expect(indexOf(mainEnd)).toBeGreaterThan(indexOf(findTurnEnd(live, childA.subagentId)));
      expect(indexOf(mainEnd)).toBeGreaterThan(indexOf(findTurnEnd(live, childB.subagentId)));

      // Each `subagent` call completes, its result is the child's last reply,
      // and its completed detail lists the child it started.
      for (const [child, description] of [
        [childA, "child A"],
        [childB, "child B"],
      ] as const) {
        const callEnd = findSubagentCallEnd(live, child);
        expect(callEnd?.status).toBe("completed");
        expect("subagentId" in callEnd!).toBe(false);
        expect(callEnd?.detail).toEqual({
          name: SUBAGENT_TOOL,
          description,
          subagentIds: [child.subagentId],
        });
      }
      const results = readToolResults(live, MAIN_TWO).join("\n");
      expect(results).toContain("Child A is done.");
      expect(results).toContain("Child B is done.");

      // The main agent's own events hold none of the children's requests.
      expect(listOpenedRequests(live, undefined)).toEqual([]);
      expect(filterByTag(filterEventsByAgent(live, undefined), "request.resolved")).toEqual([]);

      // Each child counts its own tokens, and the session's count is the sum:
      // two model calls per agent, at 100, 10 and 1 prompt tokens a call.
      await waitReportingEvents(
        live,
        "reported the session's usage as the sum of every agent's",
        () => readLatestUsage(live, undefined)?.inputTokens === 222,
      );
      expect(readLatestUsage(live, childA.subagentId)?.inputTokens).toBe(20);
      expect(readLatestUsage(live, childB.subagentId)?.inputTokens).toBe(2);
      expect(live.requestLog.unscripted).toEqual([]);
      await live.stop();
    },
    BUDGET_MS,
  );

  it(
    "stops one subagent and the subagent it started, and lets the main agent carry on",
    async () => {
      const marker = join(createScratchDir(), "leaf-ran");
      const mainInput = "Start one subagent that delegates further.";
      const middleBrief = "You are the middle child. Start a subagent of your own.";
      const leafBrief = "You are the leaf child. Run one shell command.";
      const live = await startLiveSession([
        {
          input: mainInput,
          act: [callSubagent("middle", middleBrief)],
          finish: "The main agent carried on.",
          promptTokens: 100,
        },
        {
          input: middleBrief,
          act: [callSubagent("leaf", leafBrief)],
          finish: "The middle child is done.",
          promptTokens: 10,
        },
        { input: leafBrief, act: [callBash(marker)], finish: "The leaf is done.", promptTokens: 1 },
      ]);
      await waitReportingEvents(
        live,
        "started the middle child and the leaf below it",
        () =>
          findSubagent(live, "middle") !== undefined && findSubagent(live, "leaf") !== undefined,
      );
      const middle = findSubagent(live, "middle")!;
      const leaf = findSubagent(live, "leaf")!;
      expect(middle.parentSubagentId).toBeUndefined();
      expect(leaf.parentSubagentId).toBe(middle.subagentId);
      // The leaf's `subagent` item is in the middle child's transcript.
      const leafCall = filterByTag(
        filterEventsByAgent(live, middle.subagentId),
        "item.started",
      ).find((event) => event.itemId === leaf.itemId);
      expect(leafCall?.kind).toBe(SUBAGENT_TOOL);

      await waitReportingEvents(
        live,
        "parked the leaf on its command",
        () => listOpenedRequests(live, leaf.subagentId).length === 1,
      );
      const request = listOpenedRequests(live, leaf.subagentId)[0]!;

      await Effect.runPromise(pi.interrupt(live.sessionId, middle.subagentId));

      await waitReportingEvents(
        live,
        "ended the middle child and the leaf",
        () =>
          findTurnEnd(live, middle.subagentId) !== undefined &&
          findTurnEnd(live, leaf.subagentId) !== undefined,
      );
      expect(findTurnEnd(live, middle.subagentId)?.state).toBe("interrupted");
      expect(findTurnEnd(live, leaf.subagentId)?.state).toBe("interrupted");
      const resolution = findResolution(live, request.request.requestId);
      expect(resolution?.subagentId).toBe(leaf.subagentId);
      expect(
        resolution !== undefined && "decision" in resolution ? resolution.decision : undefined,
      ).toBe("cancel");

      // The main agent sees a failed tool call, and its turn goes on to the end.
      await waitReportingEvents(
        live,
        "let the main turn carry on to its end",
        () => findTurnEnd(live, undefined) !== undefined,
      );
      expect(findTurnEnd(live, undefined)?.state).toBe("completed");
      expect(findSubagentCallEnd(live, middle)?.status).toBe("failed");
      expect(existsSync(marker), "the stopped leaf ran its command").toBe(false);
      expect(live.requestLog.unscripted).toEqual([]);
      await live.stop();
    },
    BUDGET_MS,
  );

  it(
    "stops every subagent and the main turn when the session is interrupted",
    async () => {
      const { live, markerA, markerB, childA, childB, requestA, requestB } =
        await startTwoParkedChildren();

      await Effect.runPromise(pi.interrupt(live.sessionId));

      await waitReportingEvents(
        live,
        "ended both subagents and the main turn",
        () =>
          findTurnEnd(live, childA.subagentId) !== undefined &&
          findTurnEnd(live, childB.subagentId) !== undefined &&
          findTurnEnd(live, undefined) !== undefined,
      );
      for (const [child, request] of [
        [childA, requestA],
        [childB, requestB],
      ] as const) {
        expect(findTurnEnd(live, child.subagentId)?.state).toBe("interrupted");
        const resolution = findResolution(live, request.request.requestId);
        expect(resolution?.subagentId).toBe(child.subagentId);
        expect(
          resolution !== undefined && "decision" in resolution ? resolution.decision : undefined,
        ).toBe("cancel");
      }
      expect(findTurnEnd(live, undefined)?.state).toBe("interrupted");
      expect(existsSync(markerA) || existsSync(markerB), "a stopped child ran its command").toBe(
        false,
      );
      await live.stop();
    },
    BUDGET_MS,
  );
});
