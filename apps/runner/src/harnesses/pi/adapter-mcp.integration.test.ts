/**
 * Checks, through the pi adapter's own `startSession`, what a user sees of the
 * MCP Gateway in a real pi: Hercule's approval card for an MCP tool call in
 * each Access Mode, the item of the call, a subagent's call reaching the
 * gateway, and the session token staying out of every file.
 *
 * The model is the stand-in of `upstream.ts`, scripted to find a tool with
 * pi's `tool_search` and call it (`mcp-model.testing.ts`). The MCP server is
 * the fake shared with the Codex tests, which records what it receives
 * (`../fake-mcp-server.testing.ts`). Neither needs a login or reaches an
 * outside service. The real pi starts with an environment built from nothing:
 * a throwaway `HOME` and agent directory, and a `PATH` of system folders.
 *
 * What this file does not assert: a real model's choice of tool, and the
 * gateway itself. The gateway is checked against pi in
 * `apps/controller/src/http/mcp-pi.integration.test.ts`.
 *
 * `HERCULE_PI_TEST_BINARY` selects a pinned binary without changing `PATH`.
 * The tests expect the behaviour of Hercule's pi floor, 1.3.0, and of newer
 * releases. Skipped when no `pi` is found. No CI job installs pi, so this
 * file runs on a developer's machine only.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import type { ApprovalDecision, HarnessEvent, SessionSpec } from "@hercule/protocol";
import { makePiAdapter } from "./adapter";
import { killProcessesHolding, runProcess, spawnPi } from "../process";
import { SESSION_TOKEN_VARIABLE } from "../../credentials/helper";
import { SEARCH_ISSUES_TOOL, startFakeMcpServer, WHOAMI_TOOL } from "../fake-mcp-server.testing";
import { buildMcpCallScript, TOOL_SEARCH_TOOL } from "./mcp-model.testing";
import { buildPiTestPath, findPiTestBinary } from "./pi-binary.testing";
import { buildContext, cleanupHomes, filterByTag, SPEC, waitUntil } from "./testing";
import { createScratchHome } from "../testing";
import { pointAtFakeModel, startScriptedModelServer } from "./upstream";

afterAll(cleanupHomes);

const binary = findPiTestBinary();

/** The value of the session token. A test looks for it in files and in the process arguments. */
const TOKEN = "tok-synthetic-pi-4c81e2";

/** The most one wait lasts: pi is a separate process that starts slowly, and several start in one test. */
const STEP_MS = 60_000;

/** The test's own limit, with room for the several pi processes of a subagent test. */
const TEST_MS = 180_000;

/** Long enough that a call that was going to run without an answer would have run. */
const UNANSWERED_MS = 500;

/** Returns the name pi shows the model, and the approval card, for a call of `tool`. */
const buildExpectedToolName = (tool: string): string => `mcp__tools__${tool}`;

/** Returns the word of a tool's name that a prompt searches for: the part after the server's name. */
const readSearchWord = (tool: string): string => tool.split("__")[1]!.split("_").at(-1)!;

type Opened = Extract<HarnessEvent, { _tag: "request.opened" }>;

type ItemEvent = Extract<HarnessEvent, { _tag: "item.started" | "item.completed" }>;

/** The pi process the adapter started: its arguments, and the folder it was given as its agent directory. */
interface SpawnedPi {
  readonly command: ReadonlyArray<string>;
  readonly agentFolder: string;
}

/** Lists every file under `directory`, as paths. */
const listFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { recursive: true, withFileTypes: true }).flatMap((entry) =>
    entry.isFile() ? [join(entry.parentPath, entry.name)] : [],
  );

/** Returns the events the session's own agent caused, which carry no subagent id. */
const filterMainEvents = (seen: ReadonlyArray<HarnessEvent>): ReadonlyArray<HarnessEvent> =>
  seen.filter((event) => !("subagentId" in event) || event.subagentId === undefined);

/** Returns the started and completed items of MCP tool calls, which are the ones whose detail says `mcp`. */
const findMcpCallItems = (seen: ReadonlyArray<HarnessEvent>): ReadonlyArray<ItemEvent> =>
  seen.filter(
    (event): event is ItemEvent =>
      (event._tag === "item.started" || event._tag === "item.completed") &&
      event.kind === "tool_call" &&
      (event.detail as { readonly kind?: string } | undefined)?.kind === "mcp",
  );

/** The things one test shares between the sessions it starts. */
const createFixture = () => {
  const mcp = startFakeMcpServer();
  const model = startScriptedModelServer(buildMcpCallScript());
  const home = createScratchHome("pi-mcp");
  pointAtFakeModel(home, model.baseUrl);
  const userHome = createScratchHome("pi-mcp-user");
  const cwd = createScratchHome("pi-mcp-cwd");
  const spawned: Array<SpawnedPi> = [];
  const stops: Array<() => Promise<void>> = [];
  onTestFinished(async () => {
    for (const stop of stops) await stop();
    mcp.stop();
    model.stop();
  });

  /** Starts a session whose gateway entry points at the fake, and returns what a test drives and reads. */
  const startRun = async (accessMode: SessionSpec["accessMode"]) => {
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
    await Effect.runPromise(
      adapter.startSession(
        sessionId,
        {
          ...SPEC,
          modelSelection: { model: "fake-model", options: { thinking: "low" } },
          accessMode,
        },
        {
          ...buildContext(home, cwd),
          binary: binary!,
          mcpServers: [{ name: "tools", url: mcp.url }],
          env: {
            PATH: buildPiTestPath(binary!),
            HOME: userHome,
            [SESSION_TOKEN_VARIABLE]: TOKEN,
          },
        },
      ),
    );
    const completedTurns = () =>
      filterMainEvents(seen).filter((event) => event._tag === "turn.completed").length;
    const listOpened = () => filterByTag(seen, "request.opened");
    const describeProgress = () =>
      `${seen.map((event) => event._tag).join(", ")}, after ${model.asked()} model requests`;
    const waitReporting = (what: string, ready: () => boolean) =>
      waitUntil(() => `${what}, having reported ${describeProgress()}`, ready, STEP_MS);
    let stopped = false;
    const run = {
      seen,
      listOpened,
      waitReporting,
      /** Stops the session and waits for its pi processes to end, so their agent folders are gone. */
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await Effect.runPromise(adapter.stopSession(sessionId, "stopped"));
        await Effect.runPromise(Fiber.interrupt(listening));
      },
      /**
       * Sends a prompt once pi is connected to the MCP server. pi connects in
       * the background while it starts. A person types for longer than that,
       * so the prompt waits for the connection, and `tool_search` then has
       * the tools to search.
       */
      send: async (text: string) => {
        await waitUntil(
          "connected to the MCP server",
          () => mcp.requests.some((request) => request.method === "tools/list"),
          STEP_MS,
        );
        await Effect.runPromise(adapter.sendInput(sessionId, { text }));
      },
      /** Sends `find <word>` and returns once that turn has ended. */
      callTool: async (tool: string) => {
        const before = completedTurns();
        await run.send(`find ${readSearchWord(tool)}`);
        await waitReporting(`the turn that calls ${tool} ended`, () => completedTurns() > before);
      },
      /**
       * Sends `find <word>` and returns the approval it opens, while the turn
       * waits for the answer. Fails when the turn ends without asking, which
       * is what a call that never reached the extension looks like.
       */
      callToolUntilAsked: async (tool: string) => {
        const askedBefore = listOpened().length;
        const turnsBefore = completedTurns();
        await run.send(`find ${readSearchWord(tool)}`);
        await waitReporting(
          `the approval of ${tool} was asked`,
          () => listOpened().length > askedBefore || completedTurns() > turnsBefore,
        );
        expect(listOpened().length, `no approval of ${tool} before the turn ended`).toBeGreaterThan(
          askedBefore,
        );
        return listOpened().at(-1)!;
      },
      /** Answers an approval and returns once the turn it held has ended. */
      answer: async (opened: Opened, decision: ApprovalDecision) => {
        const before = completedTurns();
        await Effect.runPromise(
          adapter.respondToApprovalRequest(sessionId, opened.request.requestId, decision),
        );
        await waitReporting(`the turn after ${decision} ended`, () => completedTurns() > before);
      },
    };
    stops.push(run.stop);
    return run;
  };

  return { mcp, home, userHome, cwd, spawned, startRun };
};

describe.skipIf(binary === undefined)("MCP tool calls in a real pi session", () => {
  describe.each(["approval-required", "auto-accept-edits"] as const)("in %s", (accessMode) => {
    it(
      "asks before each call, also for a tool marked read only, runs none when denied and one once when allowed",
      async () => {
        const { mcp, startRun } = createFixture();
        const run = await startRun(accessMode);

        // The first call is denied. pi holds it until the answer comes, so the server cannot have it yet.
        const denied = await run.callToolUntilAsked(SEARCH_ISSUES_TOOL);
        expect(denied.request).toMatchObject({
          kind: "tool_approval",
          detail: { toolName: buildExpectedToolName(SEARCH_ISSUES_TOOL) },
        });
        await new Promise((resolve) => setTimeout(resolve, UNANSWERED_MS));
        expect(mcp.listCalledTools()).toEqual([]);
        await run.answer(denied, "deny");
        expect(mcp.listCalledTools()).toEqual([]);
        expect(findMcpCallItems(run.seen).at(-1)).toMatchObject({
          _tag: "item.completed",
          status: "declined",
        });

        // The second call is of a tool marked read only, and is asked about too.
        const allowed = await run.callToolUntilAsked(WHOAMI_TOOL);
        // The approval is filed under the call's own item, so a surface can show it there.
        expect(allowed.request.itemId).toBe(findMcpCallItems(run.seen).at(-1)!.itemId);
        expect(mcp.listCalledTools()).toEqual([]);
        await run.answer(allowed, "allow");
        expect(mcp.listCalledTools()).toEqual([WHOAMI_TOOL]);
        // The item names the MCP Server and the tool, as the model's tool is `<server>__<tool>`.
        const [server, name] = WHOAMI_TOOL.split("__");
        expect(findMcpCallItems(run.seen).slice(-2)).toMatchObject([
          { _tag: "item.started", detail: { name, server, kind: "mcp" } },
          { _tag: "item.completed", status: "completed", detail: { name, server, kind: "mcp" } },
        ]);
        expect(run.listOpened()).toHaveLength(2);
      },
      TEST_MS,
    );
  });

  it(
    "runs both calls without asking in full-access",
    async () => {
      const { mcp, startRun } = createFixture();
      const run = await startRun("full-access");
      await run.callTool(SEARCH_ISSUES_TOOL);
      await run.callTool(WHOAMI_TOOL);
      expect(run.listOpened()).toEqual([]);
      expect(mcp.listCalledTools()).toEqual([SEARCH_ISSUES_TOOL, WHOAMI_TOOL]);
    },
    TEST_MS,
  );

  it(
    "never asks about tool_search, which only loads a tool for the model, and asks about the call it found",
    async () => {
      const { startRun } = createFixture();
      const run = await startRun("approval-required");

      const opened = await run.callToolUntilAsked(WHOAMI_TOOL);

      // The search ran and ended before the model could call what it found, and it opened nothing.
      const search = filterByTag(run.seen, "item.completed").find(
        (event) =>
          (event.detail as { readonly name?: string } | undefined)?.name === TOOL_SEARCH_TOOL,
      );
      expect(search?.status).toBe("completed");
      expect(run.listOpened()).toHaveLength(1);
      expect(opened.request.detail).toMatchObject({ toolName: buildExpectedToolName(WHOAMI_TOOL) });
    },
    TEST_MS,
  );

  describe("in a subagent", () => {
    it(
      "reaches the MCP server with the subagent's own call, in full-access",
      async () => {
        const { mcp, startRun } = createFixture();
        const run = await startRun("full-access");

        await run.send("delegate whoami");
        await run.waitReporting("the subagent called the tool", () =>
          mcp.listCalledTools().includes(WHOAMI_TOOL),
        );

        expect(mcp.listCalledTools()).toEqual([WHOAMI_TOOL]);
        const started = filterByTag(run.seen, "subagent.started");
        expect(started).toHaveLength(1);
        // The call is the subagent's, not the session's own.
        const calls = findMcpCallItems(run.seen);
        expect(calls).not.toEqual([]);
        expect(
          calls.every(
            (event) => "subagentId" in event && event.subagentId === started[0]!.subagentId,
          ),
        ).toBe(true);
      },
      TEST_MS,
    );

    it(
      "asks about the subagent's call under the subagent's own id, and runs it once when allowed",
      async () => {
        const { mcp, startRun } = createFixture();
        const run = await startRun("approval-required");

        await run.send("delegate whoami");
        await run.waitReporting(
          "the subagent's call was asked about",
          () => run.listOpened().length > 0,
        );

        const [started] = filterByTag(run.seen, "subagent.started");
        const opened = run.listOpened();
        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatchObject({
          subagentId: started!.subagentId,
          request: {
            kind: "tool_approval",
            detail: { toolName: buildExpectedToolName(WHOAMI_TOOL) },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, UNANSWERED_MS));
        expect(mcp.listCalledTools()).toEqual([]);

        await run.answer(opened[0]!, "allow");
        expect(mcp.listCalledTools()).toEqual([WHOAMI_TOOL]);
      },
      TEST_MS,
    );
  });

  it(
    "keeps the token out of every argument and every file under the session's folders",
    async () => {
      const { mcp, home, userHome, cwd, spawned, startRun } = createFixture();
      const run = await startRun("approval-required");
      await run.answer(await run.callToolUntilAsked(SEARCH_ISSUES_TOOL), "allow");
      expect(mcp.requests.length).toBeGreaterThan(0);
      expect(mcp.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(
        true,
      );

      // The folders are listed while pi runs: it removes its agent folder when it exits.
      const scanFolders = [home, userHome, cwd, ...spawned.map((one) => one.agentFolder)];
      const findTokenFiles = () =>
        scanFolders
          .filter(existsSync)
          .flatMap(listFiles)
          .filter((file) => readFileSync(file).includes(TOKEN));
      expect(scanFolders.filter(existsSync).flatMap(listFiles).length).toBeGreaterThan(0);
      expect(findTokenFiles()).toEqual([]);
      for (const one of spawned) expect(one.command.join(" ")).not.toContain(TOKEN);
      await run.stop();
      expect(findTokenFiles()).toEqual([]);
    },
    TEST_MS,
  );
});
