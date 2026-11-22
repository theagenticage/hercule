/**
 * Starts a real pi through the pi adapter's own `startSession`, on the scripted
 * stand-in model, and gives a test what it needs to drive the session: send an
 * input, wait for a turn to end, answer an approval, and read the events and
 * the processes the adapter started. Both real-pi suites of the MCP Gateway use
 * it: `adapter-mcp.integration.test.ts` beside this file, and
 * `apps/controller/src/http/mcp-pi.integration.test.ts`.
 *
 * The real pi starts with an environment built from nothing: a throwaway
 * `HOME`, Harness Home and working directory, and a `PATH` of system folders
 * (see `buildPiTestPath`). Nothing of the developer's own `~/.pi` or
 * `~/.hercule` is read or written. Each session registers its own stop with
 * `onTestFinished`, so a test that fails halfway leaves no pi running.
 */
import { Effect, Fiber, Stream } from "effect";
import { onTestFinished } from "vitest";
import { MCP_GATEWAY_ENTRY_NAME } from "@hercule/protocol";
import type { ApprovalDecision, HarnessEvent, SessionSpec } from "@hercule/protocol";
import { SESSION_TOKEN_VARIABLE } from "../../credentials/helper";
import { killProcessesHolding, runProcess, spawnPi } from "../process";
import { createScratchHome } from "../testing";
import { makePiAdapter } from "./adapter";
import { buildPiTestPath } from "./pi-binary.testing";
import { buildContext, filterByTag, SPEC, waitUntil } from "./testing";
import { pointAtFakeModel, type FakeModelServer } from "./upstream";

/** The most one wait lasts: pi is a separate process that starts slowly, and several start in one test. */
const STEP_MS = 60_000;

/** A request the session opened for an approval. */
export type OpenedApproval = Extract<HarnessEvent, { _tag: "request.opened" }>;

/** A pi process the adapter started: its command line, and the folder it was given as its agent directory. */
export interface SpawnedPi {
  readonly command: ReadonlyArray<string>;
  readonly agentFolder: string;
}

/** Returns the events the session's own agent caused, which carry no subagent id. */
const filterMainEvents = (seen: ReadonlyArray<HarnessEvent>): ReadonlyArray<HarnessEvent> =>
  seen.filter((event) => !("subagentId" in event) || event.subagentId === undefined);

/** What a test drives and reads of one pi session. */
export interface RealPiSession {
  /** Every event the session reported, oldest first. */
  readonly seen: ReadonlyArray<HarnessEvent>;
  /** The scratch Harness Home, the scratch `HOME` and the working directory of the session. */
  readonly folders: { readonly home: string; readonly userHome: string; readonly cwd: string };
  /** Every pi process the adapter started for the session: its own, then each subagent's. */
  readonly spawned: ReadonlyArray<SpawnedPi>;
  readonly listOpened: () => ReadonlyArray<OpenedApproval>;
  /** Waits until `ready` is true. The failure message says what the session had reported by then. */
  readonly waitReporting: (what: string, ready: () => boolean) => Promise<void>;
  /** Counts the turns the session's own agent has finished. */
  readonly countCompletedTurns: () => number;
  /** Sends an input at once, whether or not pi has connected to its MCP servers yet. */
  readonly sendInput: (text: string) => Promise<void>;
  /** Sends an input and returns once its turn has ended. */
  readonly runTurn: (text: string) => Promise<void>;
  /** Answers an approval and returns once the turn it held has ended. */
  readonly answer: (opened: OpenedApproval, decision: ApprovalDecision) => Promise<void>;
  /** Stops the session and waits for its pi processes to end, so their agent folders are gone. Safe to call twice. */
  readonly stop: () => Promise<void>;
}

/**
 * Starts a session in the real pi `binary` whose one MCP server entry, the MCP
 * Gateway's, is at `mcpUrl`, and whose model is `model`. `sessionToken`
 * is the session token pi finds in its environment. Returns once the adapter
 * has started the session, which does not wait for pi to connect to the MCP
 * server: the test decides whether to wait.
 */
export const startRealPiSession = async (options: {
  readonly binary: string;
  readonly mcpUrl: string;
  readonly sessionToken: string;
  readonly model: FakeModelServer;
  readonly accessMode: SessionSpec["accessMode"];
}): Promise<RealPiSession> => {
  const folders = {
    home: createScratchHome("pi-mcp"),
    userHome: createScratchHome("pi-mcp-user"),
    cwd: createScratchHome("pi-mcp-cwd"),
  };
  pointAtFakeModel(folders.home, options.model.baseUrl);
  const spawned: Array<SpawnedPi> = [];
  const adapter = makePiAdapter({
    spawn: (command, env, directory) => {
      spawned.push({ command, agentFolder: env["PI_CODING_AGENT_DIR"]! });
      return spawnPi(command, env, directory);
    },
    run: runProcess,
    killProcessesHolding,
  });
  const sessionId = crypto.randomUUID();
  const seen: Array<HarnessEvent> = [];
  const listening = Effect.runFork(
    Stream.runForEach(adapter.events, (event) =>
      Effect.sync(() => {
        if (event.sessionId === sessionId) seen.push(event);
      }),
    ),
  );
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Effect.runPromise(adapter.stopSession(sessionId, "stopped"));
    await Effect.runPromise(Fiber.interrupt(listening));
  };
  onTestFinished(stop);
  await Effect.runPromise(
    adapter.startSession(
      sessionId,
      {
        ...SPEC,
        modelSelection: { model: "fake-model", options: { thinking: "low" } },
        accessMode: options.accessMode,
      },
      {
        ...buildContext(folders.home, folders.cwd),
        binary: options.binary,
        mcpServers: [{ name: MCP_GATEWAY_ENTRY_NAME, url: options.mcpUrl }],
        env: {
          PATH: buildPiTestPath(options.binary),
          HOME: folders.userHome,
          [SESSION_TOKEN_VARIABLE]: options.sessionToken,
        },
      },
    ),
  );

  const countCompletedTurns = (): number =>
    filterMainEvents(seen).filter((event) => event._tag === "turn.completed").length;
  const waitReporting = (what: string, ready: () => boolean): Promise<void> =>
    waitUntil(
      () =>
        `${what}, having reported ${seen.map((event) => event._tag).join(", ")}, after ${String(options.model.asked())} model requests`,
      ready,
      STEP_MS,
    );
  const sendInput = (text: string): Promise<void> =>
    Effect.runPromise(adapter.sendInput(sessionId, { text })).then(() => undefined);
  return {
    seen,
    folders,
    spawned,
    listOpened: () => filterByTag(seen, "request.opened"),
    waitReporting,
    countCompletedTurns,
    sendInput,
    runTurn: async (text) => {
      const before = countCompletedTurns();
      await sendInput(text);
      await waitReporting(`the turn of "${text}" ended`, () => countCompletedTurns() > before);
    },
    answer: async (opened, decision) => {
      const before = countCompletedTurns();
      await Effect.runPromise(
        adapter.respondToApprovalRequest(sessionId, opened.request.requestId, decision),
      );
      await waitReporting(`the turn after ${decision} ended`, () => countCompletedTurns() > before);
    },
    stop,
  };
};
