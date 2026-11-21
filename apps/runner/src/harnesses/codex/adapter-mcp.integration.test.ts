/**
 * Checks, through the Codex adapter's own `startSession`, what a user sees of
 * the MCP Gateway in a real Codex app-server: Hercule's approval card for an
 * MCP tool call in each Access Mode, the item of the call, and a resumed or
 * forked session still reaching the gateway.
 *
 * The model is a local Responses API fixture that calls the tool the test
 * names (`mock-model.testing.ts`), and the MCP server is a fake that records
 * what it receives (`fake-mcp-server.testing.ts`). Neither needs a login or
 * calls an outside service.
 *
 * `HERCULE_CODEX_TEST_BINARY` can select a pinned binary without changing PATH.
 * What Codex shows depends on its version, so the tests read the version from
 * the binary and expect what that version does.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { Effect } from "effect";
import type { ApprovalDecision, HarnessEvent, SessionSpec } from "@hercule/protocol";
import { makeCodexAdapter } from "./adapter";
import { buildNoToolListChangedWarning } from "./mcp";
import { runProcess, spawnAppServer } from "../process";
import type { AppServerSpawn } from "./rpc";
import { createFixtureWatch } from "./fixture-watch.testing";
import { startMcpCallModel } from "./mock-model.testing";
import {
  SEARCH_ISSUES_TOOL,
  SNAPSHOT_IMAGE_TOOL,
  startFakeMcpServer,
  WHOAMI_TOOL,
} from "./fake-mcp-server.testing";
import { cleanupHomes, createScratchHome, PNG_BYTES } from "../testing";
import { buildContext, SESSION, SPEC } from "./testing";

afterAll(cleanupHomes);

const binary = process.env["HERCULE_CODEX_TEST_BINARY"] ?? Bun.which("codex") ?? undefined;

/** The value of the session token. A test looks for it in files and in the process arguments. */
const TOKEN = "tok-synthetic-7f3a9c";

/** The name of the environment variable the adapter gives Codex for the token. */
const TOKEN_VARIABLE = "HERCULE_TOKEN";

/** Reads the version of the Codex binary, such as `0.169.0`. */
const readCodexVersion = (): string => {
  const output = Bun.spawnSync([binary!, "--version"], {
    env: { PATH: process.env["PATH"] ?? "" },
  }).stdout.toString();
  return /\d+\.\d+\.\d+/.exec(output)![0];
};

const codexVersion = binary === undefined ? "0.0.0" : readCodexVersion();

/**
 * Codex re-reads a server's tool list only from 0.164.0, and only then does
 * the adapter set the feature instead of warning.
 */
const hasToolListFeature = Bun.semver.satisfies(codexVersion, ">=0.164.0");

/**
 * Codex names the tool in the approval of an MCP tool call from 0.167.0 on (0.166.0 and older send none).
 * Without a tool name, the card shows the server instead.
 */
const namesToolInApproval = Bun.semver.satisfies(codexVersion, ">=0.167.0");

/** Returns the name the approval card shows for a call of `tool`. */
const buildExpectedCardName = (tool: string): string =>
  namesToolInApproval ? `mcp__tools__${tool}` : "tools";

type Opened = Extract<HarnessEvent, { _tag: "request.opened" }>;

/** A process the adapter started, and what it was given. */
interface SpawnedAppServer {
  readonly command: ReadonlyArray<string>;
  /** Each text the adapter wrote to the app-server, one frame each. */
  readonly written: Array<string>;
  readonly exited: Promise<number>;
}

/** The things one test shares between the sessions it starts. */
const createFixture = () => {
  const mcp = startFakeMcpServer();
  const model = startMcpCallModel();
  const home = createScratchHome("mcp");
  mkdirSync(join(home, "codex"));
  writeFileSync(join(home, "codex", "config.toml"), model.config);
  const userHome = createScratchHome("mcp-user");
  const cwd = createScratchHome("mcp-cwd");
  const runs: Array<{ readonly stop: () => Promise<void> }> = [];
  onTestFinished(async () => {
    for (const run of runs) await run.stop();
    mcp.stop();
    await model.stop();
  });

  /**
   * Starts a session in the shared home, and returns what a test drives and
   * reads. `spec.continue` resumes or forks a thread an earlier run saved.
   */
  const startRun = async (
    accessMode: SessionSpec["accessMode"],
    carried?: SessionSpec["continue"],
  ) => {
    const spawned: Array<SpawnedAppServer> = [];
    const appServer: AppServerSpawn = (command, env) => {
      const child = spawnAppServer(command, env);
      const record: SpawnedAppServer = { command, written: [], exited: child.exited };
      spawned.push(record);
      return {
        ...child,
        write: (text) => {
          record.written.push(text);
          child.write(text);
        },
      };
    };
    const adapter = makeCodexAdapter({ appServer, run: runProcess });
    const watch = createFixtureWatch();
    watch.record(adapter.events);
    const context = buildContext(home, cwd);
    const binding = await Effect.runPromise(
      adapter.startSession(
        SESSION,
        {
          ...SPEC,
          accessMode,
          modelSelection: { model: "gpt-5.4", options: {} },
          ...(carried === undefined ? {} : { continue: carried }),
        },
        {
          ...context,
          binary: binary!,
          mcpServers: [{ name: "tools", url: mcp.url }],
          env: {
            PATH: process.env["PATH"] ?? "",
            HOME: userHome,
            [TOKEN_VARIABLE]: TOKEN,
            HERCULE_CODEX_FIXTURE_KEY: "dummy-local-key",
          },
        },
      ),
    );
    const { seen } = watch;
    const completedTurns = () => seen.filter((event) => event._tag === "turn.completed").length;
    const listOpened = () =>
      seen.filter((event): event is Opened => event._tag === "request.opened");
    const run = {
      adapter,
      binding,
      seen,
      spawned,
      listOpened,
      /** Stops the session and waits until its app-server has exited, so a later run may use the thread. */
      stop: async () => {
        await Effect.runPromise(adapter.stopSession(SESSION, "stopped"));
        await Promise.all(spawned.map((one) => one.exited));
      },
      /** Sends `call <tool>` and returns once that turn has ended. */
      callTool: async (tool: string) => {
        const before = completedTurns();
        await Effect.runPromise(adapter.sendInput(SESSION, { text: `call ${tool}` }));
        await watch.waitUntil(`the turn that calls ${tool}`, () => completedTurns() > before);
      },
      /**
       * Sends `call <tool>` and returns the approval it opens, while the turn
       * waits for the answer. Fails when the turn ends without asking, which is
       * what a tool that never reached Codex looks like.
       */
      callToolUntilAsked: async (tool: string) => {
        const askedBefore = listOpened().length;
        const turnsBefore = completedTurns();
        await Effect.runPromise(adapter.sendInput(SESSION, { text: `call ${tool}` }));
        await watch.waitUntil(
          `the approval of ${tool}`,
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
          adapter.respondToApprovalRequest(SESSION, opened.request.requestId, decision),
        );
        await watch.waitUntil(`the turn after ${decision}`, () => completedTurns() > before);
      },
    };
    runs.push(run);
    return run;
  };

  return { mcp, model, home, userHome, cwd, startRun };
};

/** Lists the warnings the runner itself adds. A warning Codex sent has `raw` and is left out. */
const listRunnerWarnings = (seen: ReadonlyArray<HarnessEvent>) =>
  seen.filter((event) => event._tag === "runtime.warning" && event.raw === undefined);

/** Returns the `item.started` of the MCP tool call item, which a test reads the item's id from. */
const findCallItems = (seen: ReadonlyArray<HarnessEvent>) =>
  seen.filter(
    (event): event is Extract<HarnessEvent, { _tag: "item.started" | "item.completed" }> =>
      (event._tag === "item.started" || event._tag === "item.completed") &&
      event.kind === "tool_call",
  );

/** Lists every file under `directory`, as paths. */
const listFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { recursive: true, withFileTypes: true }).flatMap((entry) =>
    entry.isFile() ? [join(entry.parentPath, entry.name)] : [],
  );

describe.skipIf(binary === undefined)("MCP tool calls in a real Codex session", () => {
  describe.each(["approval-required", "auto-accept-edits"] as const)("in %s", (accessMode) => {
    it.each([
      ["deny", "failed"],
      ["cancel", "failed"],
    ] as const)(
      "asks before each call and runs none when the answer is %s",
      async (decision, status) => {
        const { mcp, startRun } = createFixture();
        const run = await startRun(accessMode);
        for (const tool of [SEARCH_ISSUES_TOOL, WHOAMI_TOOL]) {
          const opened = await run.callToolUntilAsked(tool);
          expect(opened.request).toMatchObject({
            kind: "tool_approval",
            decisions: ["allow", "deny", "cancel"],
            detail: { toolName: buildExpectedCardName(tool) },
          });
          // Codex waits for the answer, so the call cannot have reached the server yet.
          expect(mcp.listCalledTools()).toEqual([]);
          await run.answer(opened, decision);
          expect(mcp.listCalledTools()).toEqual([]);
          expect(findCallItems(run.seen).at(-1)).toMatchObject({
            _tag: "item.completed",
            status,
          });
        }
      },
    );

    it("asks before each call, also for a tool marked read only, and runs it once when allowed", async () => {
      const { mcp, startRun } = createFixture();
      const run = await startRun(accessMode);
      const calledSoFar: Array<string> = [];
      for (const tool of [SEARCH_ISSUES_TOOL, WHOAMI_TOOL]) {
        const opened = await run.callToolUntilAsked(tool);
        expect(opened.request).toMatchObject({
          kind: "tool_approval",
          detail: { toolName: buildExpectedCardName(tool) },
        });
        // The approval is filed under the call's own item, so a surface can show it there.
        expect(opened.request.itemId).toBe(findCallItems(run.seen).at(-1)!.itemId);
        expect(mcp.listCalledTools()).toEqual(calledSoFar);
        await run.answer(opened, "allow");
        calledSoFar.push(tool);
        expect(mcp.listCalledTools()).toEqual(calledSoFar);
        // The item names the MCP Server and the tool, as the model's tool is `<server>__<tool>`.
        const [server, name] = tool.split("__");
        expect(findCallItems(run.seen).slice(-2)).toMatchObject([
          { _tag: "item.started", detail: { name, server, kind: "mcp" } },
          {
            _tag: "item.completed",
            status: "completed",
            // The expanded step shows what the tool returned.
            detail: { name, server, kind: "mcp", content: [{ text: `result of ${tool}` }] },
            raw: { payload: { item: { result: { content: [{ text: `result of ${tool}` }] } } } },
          },
        ]);
      }
      expect(run.listOpened()).toHaveLength(2);
    });
  });

  it("runs both calls without asking in full-access", async () => {
    const { mcp, startRun } = createFixture();
    const run = await startRun("full-access");
    await run.callTool(SEARCH_ISSUES_TOOL);
    await run.callTool(WHOAMI_TOOL);
    expect(run.listOpened()).toEqual([]);
    expect(mcp.listCalledTools()).toEqual([SEARCH_ISSUES_TOOL, WHOAMI_TOOL]);
  });

  it("marks an image of a tool result unavailable, and puts no image bytes in an event", async () => {
    const { startRun } = createFixture();
    const run = await startRun("full-access");
    await run.callTool(SNAPSHOT_IMAGE_TOOL);
    expect(JSON.stringify(run.seen)).not.toContain(PNG_BYTES.toString("base64"));
    const notKeptNotice: unknown = expect.stringContaining("does not keep");
    const content = [
      { type: "text", text: `result of ${SNAPSHOT_IMAGE_TOOL}` },
      { type: "image", unavailable: notKeptNotice },
    ];
    expect(findCallItems(run.seen).at(-1)).toMatchObject({
      _tag: "item.completed",
      status: "completed",
      // The expanded step shows the text and the image's notice, and `raw` the same.
      detail: { content },
      raw: { payload: { item: { result: { content } } } },
    });
  });

  describe("in auto", () => {
    it("lets Codex's reviewer allow the call, and shows no approval", async () => {
      const { mcp, model, startRun } = createFixture();
      model.reviewer.outcome = "allow";
      const run = await startRun("auto");
      await run.callTool(SEARCH_ISSUES_TOOL);
      expect(run.listOpened()).toEqual([]);
      expect(mcp.listCalledTools()).toEqual([SEARCH_ISSUES_TOOL]);
    });

    it("lets Codex's reviewer deny the call, and runs none", async () => {
      const { mcp, model, startRun } = createFixture();
      model.reviewer.outcome = "deny";
      const run = await startRun("auto");
      await run.callTool(SEARCH_ISSUES_TOOL);
      expect(run.listOpened()).toEqual([]);
      expect(mcp.listCalledTools()).toEqual([]);
      expect(findCallItems(run.seen).at(-1)).toMatchObject({
        _tag: "item.completed",
        status: "failed",
      });
    });
  });

  describe.each(["resume", "fork"] as const)("after a %s", (mode) => {
    it("connects to the gateway again with the token, and still asks before a call", async () => {
      const { mcp, startRun } = createFixture();
      const first = await startRun("approval-required");
      await first.answer(await first.callToolUntilAsked(WHOAMI_TOOL), "allow");
      await first.stop();
      const requestsBefore = mcp.requests.length;

      const second = await startRun("approval-required", {
        nativeSessionId: first.binding.nativeSessionId,
        mode,
      });
      const opened = await second.callToolUntilAsked(SEARCH_ISSUES_TOOL);
      expect(opened.request.detail).toMatchObject({
        toolName: buildExpectedCardName(SEARCH_ISSUES_TOOL),
      });
      await second.answer(opened, "allow");

      const after = mcp.requests.slice(requestsBefore);
      expect(after.map((request) => request.method)).toContain("initialize");
      expect(after.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
      expect(mcp.listCalledTools()).toEqual([WHOAMI_TOOL, SEARCH_ISSUES_TOOL]);
    });
  });

  it("keeps the token out of the app-server's arguments and out of every file", async () => {
    const { mcp, home, userHome, cwd, startRun } = createFixture();
    const run = await startRun("approval-required");
    await run.answer(await run.callToolUntilAsked(SEARCH_ISSUES_TOOL), "allow");
    expect(mcp.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);

    for (const spawned of run.spawned) {
      expect(spawned.command.join(" ")).not.toContain(TOKEN);
      expect(spawned.written.join("")).not.toContain(TOKEN);
    }
    // Codex is told the variable's name and reads the value itself.
    const started = run.spawned[0]!.written.map(
      (text) => JSON.parse(text) as { method?: string; params?: { config?: unknown } },
    ).find((frame) => frame.method === "thread/start");
    expect(started?.params?.config).toMatchObject({
      "mcp_servers.tools.bearer_token_env_var": TOKEN_VARIABLE,
    });
    // While the session runs, Codex keeps a snapshot of the shell's environment in
    // `shell_snapshots/`, and that file holds every variable, the token included.
    // Codex deletes it when the app-server exits, so it is left out here. After
    // the stop it is checked too, but only for a Codex that deletes it: before
    // 0.169.0, Codex leaves the file behind (known issue #1234).
    const scanFolders = [home, userHome, cwd];
    const findTokenFiles = (includeSnapshots: boolean) =>
      scanFolders
        .flatMap(listFiles)
        .filter((file) => includeSnapshots || !file.includes("/shell_snapshots/"))
        .filter((file) => readFileSync(file).includes(TOKEN));
    expect(scanFolders.flatMap(listFiles).length).toBeGreaterThan(0);
    expect(findTokenFiles(false)).toEqual([]);
    await run.stop();
    expect(findTokenFiles(Bun.semver.satisfies(codexVersion, ">=0.169.0"))).toEqual([]);
  });

  describe("when a trusted project's config sets an MCP server", () => {
    /**
     * Writes the project's `.codex/config.toml` into the session's folder and
     * trusts the folder: Codex loads a project's config only for a project
     * the user has trusted.
     */
    const trustProject = (home: string, cwd: string, toml: string): void => {
      mkdirSync(join(cwd, ".codex"));
      writeFileSync(join(cwd, ".codex", "config.toml"), toml);
      appendFileSync(
        join(home, "codex", "config.toml"),
        `\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`,
      );
    };

    it("gives the thread no gateway when the project sets the gateway's name, and says so", async () => {
      const { mcp, home, cwd, startRun } = createFixture();
      const projectOnly = startFakeMcpServer();
      onTestFinished(() => projectOnly.stop());
      // A project could lower the approval of a gateway tool this way, and
      // Codex merges its table into the gateway's, so the name is left alone.
      trustProject(
        home,
        cwd,
        [
          "[mcp_servers.tools]",
          `url = "${projectOnly.url}"`,
          `[mcp_servers.tools.tools.${SEARCH_ISSUES_TOOL}]`,
          'approval_mode = "approve"',
        ].join("\n"),
      );
      const run = await startRun("approval-required");

      await run.callTool(SEARCH_ISSUES_TOOL);

      expect(mcp.requests).toEqual([]);
      expect(mcp.listCalledTools()).toEqual([]);
      expect(run.listOpened()).toEqual([]);
      const messages = listRunnerWarnings(run.seen).map((warning) =>
        warning._tag === "runtime.warning" ? warning.message : "",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(join(cwd, ".codex"));
      expect(messages[0]).toContain("config.toml");
      expect(messages[0]).toContain('MCP server named "tools"');
    });

    it("gives the thread no gateway for a project that becomes trusted when the thread opens, and says so", async () => {
      const { mcp, cwd, startRun } = createFixture();
      const projectOnly = startFakeMcpServer();
      onTestFinished(() => projectOnly.stop());
      // The Harness Home has no trust entry for the folder yet. A writable
      // sandbox makes `thread/start` trust it and merge this table on that same
      // call, after the configuration was read, and a project that is not
      // trusted yet is listed with its settings but none of its effective keys.
      mkdirSync(join(cwd, ".codex"));
      writeFileSync(
        join(cwd, ".codex", "config.toml"),
        ["[mcp_servers.tools]", `url = "${projectOnly.url}"`, "enabled = false"].join("\n"),
      );
      const run = await startRun("auto-accept-edits");

      await run.callTool(SEARCH_ISSUES_TOOL);

      expect(mcp.requests).toEqual([]);
      expect(mcp.listCalledTools()).toEqual([]);
      const messages = listRunnerWarnings(run.seen).map((warning) =>
        warning._tag === "runtime.warning" ? warning.message : "",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(join(cwd, ".codex"));
      expect(messages[0]).toContain('MCP server named "tools"');
    });

    it("still gives the thread the gateway when the project sets only another server", async () => {
      const { mcp, home, cwd, startRun } = createFixture();
      // Codex connects to this server only when it loads the project's config,
      // which proves the config took effect.
      const docs = startFakeMcpServer();
      onTestFinished(() => docs.stop());
      trustProject(home, cwd, ["[mcp_servers.docs]", `url = "${docs.url}"`].join("\n"));
      const run = await startRun("approval-required");

      const opened = await run.callToolUntilAsked(SEARCH_ISSUES_TOOL);
      expect(docs.requests.map((request) => request.method)).toContain("initialize");
      expect(opened.request.detail).toMatchObject({
        toolName: buildExpectedCardName(SEARCH_ISSUES_TOOL),
      });
      await run.answer(opened, "allow");

      expect(mcp.listCalledTools()).toEqual([SEARCH_ISSUES_TOOL]);
      // The only runner warning that may appear is the tool list one of an older Codex.
      expect(
        listRunnerWarnings(run.seen).filter(
          (warning) =>
            warning._tag === "runtime.warning" && warning.message.includes("configures an MCP"),
        ),
      ).toEqual([]);
    });
  });

  it("sets the tool list feature for a Codex that has it, and warns for one that has not", async () => {
    const { startRun } = createFixture();
    const run = await startRun("approval-required");
    const started = run.spawned[0]!.written.map(
      (text) => JSON.parse(text) as { method?: string; params?: { config?: object } },
    ).find((frame) => frame.method === "thread/start");
    const warnings = listRunnerWarnings(run.seen);
    if (hasToolListFeature) {
      expect(started?.params?.config).toMatchObject({ "features.mcp_tool_list_changed": true });
      expect(warnings).toEqual([]);
    } else {
      expect(started?.params?.config).not.toHaveProperty(["features.mcp_tool_list_changed"]);
      expect(
        warnings.map((warning) => (warning._tag === "runtime.warning" ? warning.message : "")),
      ).toEqual([buildNoToolListChangedWarning(codexVersion)]);
    }
  });
});
