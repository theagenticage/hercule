/**
 * Tests approvals against the real pi binary: a tool call the user has not
 * answered really waits, and answering it really lets it run. A fake pi can
 * only check what the adapter writes. Only the real binary proves that the
 * extension loads, that its dialog reaches Hercule, and that pi holds the tool
 * call until the answer comes back.
 *
 * No paid key and no real model: `models.json` in the throwaway agent directory
 * points the `zai` provider at a local server that replies with fake tool
 * calls. The developer's own `~/.pi` is never read or written, and the only
 * process stopped is the one the adapter started.
 *
 * Skips without `pi` on PATH, like the other integration tests here.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { AccessMode, ProviderEvent, SessionSpec } from "@hercule/protocol";
import { pi } from "./adapter";
import { cleanupHomes, buildContext, TEST_ZAI_KEY, SPEC, filterByTag, waitUntil } from "./testing";
import { createScratchHome } from "../testing";
import {
  PARKED_COMMAND,
  PARKED_OUTPUT,
  pointAtFakeModel,
  startFakeModelServer,
  type FakeModelFirstTurn,
  type FakeModelServer,
} from "./upstream";

const binary = Bun.which("pi") ?? undefined;

const upstreams: Array<FakeModelServer> = [];

afterAll(() => {
  cleanupHomes();
  for (const upstream of upstreams.splice(0)) upstream.stop();
});

const createScratchDir = (): string => createScratchHome("pi-park");

const BUDGET_MS = 120_000;

/** Long enough that a tool call that was going to run anyway would have run. */
const UNANSWERED_MS = 2_000;

/** Builds the session spec under test: the fake model, with the given access mode. */
const buildSpec = (accessMode: AccessMode): SessionSpec => ({
  ...SPEC,
  modelSelection: { model: "fake-model", options: { thinking: "low" } },
  accessMode,
});

interface Live {
  readonly sessionId: string;
  /** The session's working directory, where its files should be written. */
  readonly cwd: string;
  readonly seen: Array<ProviderEvent>;
  readonly stop: () => Promise<void>;
}

const startLiveSession = async (
  firstTurn: FakeModelFirstTurn = {},
  accessMode: AccessMode = "approval-required",
): Promise<Live> => {
  const upstream = startFakeModelServer(firstTurn);
  upstreams.push(upstream);
  const home = createScratchDir();
  pointAtFakeModel(home, upstream.baseUrl);
  const cwd = createScratchDir();
  // The fake server checks no key. The real PATH is passed so pi can find
  // the shell it runs the command with.
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
  await Effect.runPromise(pi.startSession(sessionId, buildSpec(accessMode), ctx));
  await Effect.runPromise(
    pi.sendInput(sessionId, { text: `Run the shell command: ${PARKED_COMMAND}` }),
  );
  return {
    sessionId,
    cwd,
    seen,
    stop: () => Effect.runPromise(pi.stopSession(sessionId, "stopped")),
  };
};

/** Waits for `ready`, and on timeout lists the events the session had reported. */
const waitReportingEvents = (live: Live, what: string, ready: () => boolean): Promise<void> =>
  waitUntil(
    () => `${what}, having reported ${live.seen.map((event) => event._tag).join(", ")}`,
    ready,
    BUDGET_MS / 2,
  );

const listOpenedRequests = (
  live: Live,
): ReadonlyArray<Extract<ProviderEvent, { _tag: "request.opened" }>> =>
  filterByTag(live.seen, "request.opened");

const findOpenedRequest = (
  live: Live,
): Extract<ProviderEvent, { _tag: "request.opened" }> | undefined => listOpenedRequests(live)[0];

const findItemEnd = (
  live: Live,
  itemId: string,
): Extract<ProviderEvent, { _tag: "item.completed" }> | undefined =>
  filterByTag(live.seen, "item.completed").find((event) => event.itemId === itemId);

const hasFinishedCommand = (live: Live, itemId: string): boolean =>
  findItemEnd(live, itemId) !== undefined;

const hasFinishedTurn = (live: Live): boolean =>
  filterByTag(live.seen, "turn.completed").length > 0;

const readCommandOutput = (live: Live, itemId: string): string =>
  filterByTag(live.seen, "content.delta")
    .filter((event) => event.itemId === itemId && event.streamKind === "command_output")
    .map((event) => event.delta)
    .join("");

describe.skipIf(binary === undefined)("a real pi parked on a tool call", () => {
  it(
    "holds the command until the user allows it, then runs it",
    async () => {
      const live = await startLiveSession({ command: `echo ${PARKED_OUTPUT} | tee ran.txt` });
      await waitReportingEvents(
        live,
        "the session was never parked",
        () => findOpenedRequest(live) !== undefined,
      );
      const request = findOpenedRequest(live)!;

      expect(request.request.kind).toBe("command_approval");
      // The tool call must not run while the approval is open.
      await new Promise((resolve) => setTimeout(resolve, UNANSWERED_MS));
      expect(
        hasFinishedCommand(live, request.request.itemId),
        "the command ran without an answer",
      ).toBe(false);
      expect(hasFinishedTurn(live), "the turn ended without an answer").toBe(false);

      await Effect.runPromise(
        pi.respondToApprovalRequest(live.sessionId, request.request.requestId, "allow"),
      );
      await waitReportingEvents(live, "the allowed command never ran", () =>
        hasFinishedCommand(live, request.request.itemId),
      );

      expect(readCommandOutput(live, request.request.itemId)).toContain(PARKED_OUTPUT);
      // The command ran where the session runs. A pi started in the runner's
      // own directory would have written this into whatever directory the
      // daemon was launched from.
      expect(existsSync(join(live.cwd, "ran.txt")), "the command ran somewhere else").toBe(true);
      expect(existsSync(join(process.cwd(), "ran.txt"))).toBe(false);
      await live.stop();
    },
    BUDGET_MS,
  );

  it(
    "blocks the command on a deny, so it never runs",
    async () => {
      const marker = join(createScratchDir(), "ran");
      const live = await startLiveSession({ command: `echo ${PARKED_OUTPUT} > ${marker}` });
      await waitReportingEvents(
        live,
        "the session was never parked",
        () => findOpenedRequest(live) !== undefined,
      );
      const request = findOpenedRequest(live)!;

      await Effect.runPromise(
        pi.respondToApprovalRequest(live.sessionId, request.request.requestId, "deny"),
      );

      await waitReportingEvents(live, "the denied command never ended", () =>
        hasFinishedCommand(live, request.request.itemId),
      );
      // The user's own answer, not something that went wrong with the command.
      expect(findItemEnd(live, request.request.itemId)?.status).toBe("declined");
      // Checking the command's side effect, not just the events, proves it did
      // not run.
      expect(existsSync(marker), "the denied command ran anyway").toBe(false);
      await live.stop();
    },
    BUDGET_MS,
  );

  it(
    "asks about each call in a batch separately, with that call's own details",
    async () => {
      const file = join(createScratchDir(), "written.txt");
      const live = await startLiveSession({ writes: file });
      await waitReportingEvents(
        live,
        "the file change was never asked about",
        () => findOpenedRequest(live) !== undefined,
      );
      const first = findOpenedRequest(live)!.request;

      expect(first.kind).toBe("file_change_approval");
      expect(first.detail).toEqual({ paths: [file] });
      // The call the card is shown on stays held while the approval is open.
      expect(hasFinishedCommand(live, first.itemId)).toBe(false);
      // One card is docked at a time; the call behind it has not run yet.
      expect(listOpenedRequests(live)).toHaveLength(1);

      await Effect.runPromise(
        pi.respondToApprovalRequest(live.sessionId, first.requestId, "allow"),
      );
      await waitReportingEvents(
        live,
        "the second call of the batch was never asked about",
        () => listOpenedRequests(live).length === 2,
      );
      const second = listOpenedRequests(live)[1]!.request;

      // Each approval is about its own call, not the most recent one.
      expect(second.itemId).not.toBe(first.itemId);
      expect(second.kind).toBe("command_approval");
      expect(second.detail).toEqual({ command: PARKED_COMMAND });
      await Effect.runPromise(
        pi.respondToApprovalRequest(live.sessionId, second.requestId, "allow"),
      );
      await waitReportingEvents(live, "the allowed command never ran", () =>
        hasFinishedCommand(live, second.itemId),
      );
      // pi asks for approval of each tool call in a batch one by one, then runs
      // all calls of the batch in parallel. So the file change can land after
      // the command finishes, and the test waits for the file instead of
      // checking once.
      await waitReportingEvents(live, "the allowed file change never landed", () =>
        existsSync(file),
      );
      await live.stop();
    },
    BUDGET_MS,
  );

  it(
    "lets a file change through under auto-accept-edits, and still asks about the command",
    async () => {
      const file = join(createScratchDir(), "written.txt");
      const live = await startLiveSession({ writes: file }, "auto-accept-edits");
      await waitReportingEvents(
        live,
        "the command was never asked about",
        () => findOpenedRequest(live) !== undefined,
      );
      const request = findOpenedRequest(live)!;

      // The point of this mode: the file change is never asked about, while
      // the shell command in the same batch still is. pi holds a whole batch
      // before running any of it, so the file change lands only once the
      // command is answered.
      expect(listOpenedRequests(live)).toHaveLength(1);
      expect(request.request.kind).toBe("command_approval");
      await Effect.runPromise(
        pi.respondToApprovalRequest(live.sessionId, request.request.requestId, "allow"),
      );
      await waitReportingEvents(live, "the file change never landed", () => existsSync(file));
      expect(listOpenedRequests(live)).toHaveLength(1);
      await live.stop();
    },
    BUDGET_MS,
  );

  it(
    "cancels the approval and ends the turn when the session is interrupted",
    async () => {
      const live = await startLiveSession();
      await waitReportingEvents(
        live,
        "the session was never parked",
        () => findOpenedRequest(live) !== undefined,
      );
      const request = findOpenedRequest(live)!;

      await Effect.runPromise(pi.interrupt(live.sessionId));

      await waitReportingEvents(live, "the park never ended", () =>
        live.seen.some(
          (event) =>
            event._tag === "request.resolved" &&
            event.requestId === request.request.requestId &&
            "decision" in event &&
            event.decision === "cancel",
        ),
      );
      await waitReportingEvents(live, "the turn never ended", () =>
        live.seen.some((event) => event._tag === "turn.completed" && event.state === "interrupted"),
      );
      await live.stop();
    },
    BUDGET_MS,
  );
});
