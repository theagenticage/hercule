/**
 * Runs the real Codex against the real MCP Gateway, to check what the spec
 * could only assume (spec 21 section 3.11): that Codex works on the older wire
 * era, sees `notifications/tools/list_changed` and lists again, opens a new MCP
 * session when the gateway answers 404 for the one it holds, and that a name
 * Codex showed the model never reaches the other tool when a twin with `-` or
 * `_` comes or goes (see the last `describe`).
 * Resuming and forking a thread is checked beside the adapter, in
 * `apps/runner/src/harnesses/codex/adapter-mcp.integration.test.ts`.
 *
 * Nothing here is billed and no login is used. Codex starts the way the Codex
 * adapter starts it: the adapter's own `buildAppServerCommand`, then `thread/start`
 * with the `config` that the adapter's own `buildMcpServerConfig` builds, the
 * session token in `HERCULE_TOKEN`, and an environment built from nothing (a
 * throwaway `HOME` and `CODEX_HOME`). The model is a local stand-in for the
 * Responses API that calls the tool a prompt names, so no real model is reached. A Codex shows the gateway's tools inline
 * or defers them behind tool search; the request says which, and when the
 * tools are deferred the stand-in searches for the tool and calls the one the
 * search returned.
 *
 * A recording proxy sits between Codex and the controller and keeps what the
 * gateway receives, as in `mcp-claude-code.integration.test.ts`.
 *
 * What this file does not assert:
 *
 * - **The text of the refusal** of a call to a server taken out of the list. It
 *   asserts that the call reached the gateway, that Codex reports the call as
 *   `failed`, and that nothing reached the server.
 * - **Codex's own relist after a removal.** Codex re-reads its list when it hears
 *   of the change and then refuses the call itself, before the gateway sees it.
 *   The removal test holds `list_changed` back so that the gateway gets the call;
 *   it does not check what Codex does when it hears of the change.
 * - **A fresh GET stream after a 404.** The 404 test checks the new MCP session
 *   and the order of the retried call and the list, not that Codex opens a stream
 *   on the new session.
 * - **A real cold gateway.** The test controller cannot restart over the same
 *   database: `withServer` makes a new Hercule Home and a new gateway for each
 *   run, and its `reboot` repeats only the boot steps inside the same process.
 *   The 404 test makes the gateway forget one MCP session instead. The new
 *   MCP session has offered no name, which is what a restart leaves, so the
 *   call Codex sends before it lists is refused once, as spec 21 section 3.4
 *   says. A call after a real restart needs a controller that can be stopped
 *   and started over one database.
 *
 * Skipped when no `codex` binary is found. `HERCULE_CODEX_TEST_BINARY` selects
 * one without changing `PATH`. No CI job installs Codex, so this file runs on a
 * developer's machine only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MCP_GATEWAY_TOOL_SEPARATOR } from "@hercule/protocol";
import { findCodexTestBinary } from "../../../runner/src/harnesses/codex/codex-binary.testing";
import { buildMcpServerConfig } from "../../../runner/src/harnesses/codex/mcp";
import {
  buildAppServerCommand,
  makeRpc,
  type AppServerChild,
  type NotificationFrame,
} from "../../../runner/src/harnesses/codex/rpc";
import { spawnAppServer, stopChild } from "../../../runner/src/harnesses/process";
import {
  startScriptedModel,
  type ScriptedModelRequest,
} from "../../../runner/src/harnesses/codex/mock-model.testing";
import type { ThreadStartParams, TurnStartParams } from "../../../runner/src/harnesses/codex/types";
import { startFakeUpstream, type FakeTool, type FakeUpstream } from "../mcp-servers/testing";
import {
  OLDER_ERA_REVISIONS,
  TWIN_SCENARIOS,
  WHOAMI_TOOL,
  buildTwinTool,
  readUpstreamCalls,
  withGatewayRig,
  type ToolChangingGatewayRig,
} from "./mcp-gateway-rig.testing";
import {
  countListChanged,
  describeRequest,
  requestsOf,
  waitUntilQuiet,
  type RecordingProxy,
} from "./mcp-recording-proxy.testing";
import { waitWithin } from "./testing";

const codex = findCodexTestBinary();

/** The most one step of these tests waits for Codex, which is a separate process that starts slowly. */
const STEP_MS = 30_000;

/** The name the gateway has as an MCP server in Codex's config, as the runner names it. */
const GATEWAY_NAME = "tools";

/** The name of the one MCP Server the tests give the Thread. */
const SERVER_NAME = "sentry";

/** The tool Codex shows the model for `sentry`'s `whoami`: the gateway's `<server>__<tool>`. */
const WHOAMI = `${SERVER_NAME}__whoami`;

// -- A stand-in for the Responses API -----------------------------------------

/** Returns the text of a user message, or an empty string for any other item. */
const readPrompt = (item: Record<string, unknown> | undefined): string =>
  item?.["role"] === "user"
    ? ((item["content"] as ReadonlyArray<{ readonly text?: string }>) ?? [])
        .map((part) => part.text ?? "")
        .join("")
    : "";

/** The shape of an entry of a model request's `tools`, and of a tool search's result: Codex's namespace of the gateway. */
type ToolEntry = Record<string, unknown>;

/** A tool of the gateway as the model is shown it. */
interface ShownTool {
  readonly name: string;
  readonly description?: string;
}

/** Returns the gateway's tools in the namespace entries among `entries`. */
const readGatewayToolEntries = (entries: ReadonlyArray<ToolEntry>): ReadonlyArray<ShownTool> =>
  entries
    .filter((entry) => entry["name"] === `mcp__${GATEWAY_NAME}`)
    .flatMap((entry) => entry["tools"] as ReadonlyArray<ShownTool>);

/**
 * Returns the gateway's tools the model has been shown in `requests`. A Codex
 * shows them in one of two shapes, and the request itself says which:
 *
 * - inline, as a `mcp__tools` namespace in the request's `tools`;
 * - deferred, as the result of a `tool_search_call`, which comes back as a
 *   `tool_search_output` item in the request's input. Such a request has a
 *   `tool_search` tool and no inline namespace.
 */
const readShownTools = (requests: ReadonlyArray<ScriptedModelRequest>): ReadonlyArray<ShownTool> =>
  requests.flatMap((request) => [
    ...readGatewayToolEntries(request.body.tools),
    ...readGatewayToolEntries(
      request.body.input
        .filter((item) => item["type"] === "tool_search_output")
        .flatMap((item) => item["tools"] as ReadonlyArray<ToolEntry>),
    ),
  ]);

/** Returns the names of the gateway's tools the model has been shown in `requests`, once each. */
const readOfferedTools = (requests: ReadonlyArray<ScriptedModelRequest>): ReadonlyArray<string> => [
  ...new Set(readShownTools(requests).map((tool) => tool.name)),
];

/**
 * Returns the name the model is shown for the gateway's tool `wanted`. Codex
 * shows a gateway name as it is, except that it turns `-` into `_` and then
 * adds a suffix of its own to names that are alike after that, so which tool
 * holds a spelling is Codex's choice and not the gateway's. A test that needs
 * such a tool ends the tool's description with its gateway name in square
 * brackets, and the tool is found by that. A tool without such a description
 * is found by its name as shown. Returns `undefined` when no tool shown matches.
 */
const findShownName = (shown: ReadonlyArray<ShownTool>, wanted: string): string | undefined =>
  (
    shown.find((tool) => tool.description?.endsWith(`[${wanted}]`)) ??
    shown.find((tool) => tool.name === wanted)
  )?.name;

/**
 * Builds the model's script. A prompt `call <tool>` makes the model call that
 * tool of the gateway once, with the argument `hello`. A prompt `call exactly
 * <name>` makes it call the name `<name>` as it is, which is how a test calls a
 * name Codex showed earlier. When Codex has not shown
 * the model the tool and offers a `tool_search` tool, the model searches for
 * the tool first and calls it only if the search returned it. Any other request
 * ends the turn.
 */
const buildCallScript = () => {
  let calls = 0;
  let searches = 0;
  let searchedFor: string | undefined;
  const buildCall = (shownName: string) => ({
    type: "function_call",
    namespace: `mcp__${GATEWAY_NAME}`,
    name: shownName,
    call_id: `call-${String(++calls)}`,
    arguments: JSON.stringify({ text: "hello" }),
  });
  return (request: ScriptedModelRequest) => {
    const last = request.body.input.at(-1);
    // `call exactly <name>` sends the name as it is, whether or not Codex shows it now.
    const exact = /^call exactly (\S+)$/.exec(readPrompt(last))?.[1];
    if (exact !== undefined) return [buildCall(exact)];
    const wanted = /call ([\w-]+)/.exec(readPrompt(last))?.[1];
    if (wanted !== undefined) {
      const shownName = findShownName(readShownTools([request]), wanted);
      const canSearch = request.body.tools.some((tool) => tool["type"] === "tool_search");
      if (canSearch && shownName === undefined) {
        searchedFor = wanted;
        return [
          {
            type: "tool_search_call",
            call_id: `search-${String(++searches)}`,
            execution: "client",
            arguments: { query: wanted, limit: 5 },
          },
        ];
      }
      return [buildCall(shownName ?? wanted)];
    }
    if (last?.["type"] === "tool_search_output" && searchedFor !== undefined) {
      const shownName = findShownName(
        readGatewayToolEntries(last["tools"] as ReadonlyArray<ToolEntry>),
        searchedFor,
      );
      return shownName === undefined ? undefined : [buildCall(shownName)];
    }
    return undefined;
  };
};

/** Returns what the model was sent back for the call `callId`, as text, or `undefined` before it was sent. */
const readCallOutput = (
  requests: ReadonlyArray<ScriptedModelRequest>,
  callId: string,
): string | undefined => {
  const output = requests
    .flatMap((request) => request.body.input)
    .find((item) => item["type"] === "function_call_output" && item["call_id"] === callId);
  return output === undefined ? undefined : JSON.stringify(output["output"]);
};

// -- The real Codex -----------------------------------------------------------

/** What a finished `mcpToolCall` item says about the call. */
interface ReportedCall {
  readonly server: string;
  readonly tool: string;
  readonly status: string;
  readonly error: { readonly message: string } | null;
}

/** A running `codex app-server`, and the questions a test can put to it. */
interface RunningCodex {
  /** Opens a thread the way the adapter does and returns its id. */
  readonly startThread: () => Promise<string>;
  /** Sends a prompt and waits until the turn ends. */
  readonly runTurn: (threadId: string, prompt: string) => Promise<void>;
  /** Returns every MCP tool call item that has finished, oldest first. */
  readonly readFinishedCalls: () => ReadonlyArray<ReportedCall>;
}

/** What `withCodexHome` makes: starts one `codex app-server` on the home. */
interface CodexHome {
  readonly start: () => Promise<RunningCodex>;
}

/**
 * Prepares a throwaway `HOME` and `CODEX_HOME` that point Codex at the stand-in
 * model, calls `body` with a way to start a `codex app-server` process on it,
 * then stops every process it started and removes the folders. The process is
 * registered for the stop when it is spawned, so one that fails to start up is
 * stopped too.
 *
 * The app-server is started and spoken to with the runner's own parts: the
 * adapter's launch command, `spawnAppServer` and the JSON-RPC codec `makeRpc`.
 * The adapter's `startSession` is not used, because this file checks the
 * gateway against the real Codex without the adapter in between.
 */
const withCodexHome = async (
  options: {
    readonly gatewayUrl: string;
    readonly sessionToken: string;
    readonly modelConfig: string;
  },
  body: (home: CodexHome) => Promise<void>,
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "hercule-codex-gateway-"));
  const codexHome = join(root, "codex");
  const cwd = join(root, "cwd");
  mkdirSync(codexHome);
  mkdirSync(cwd);
  writeFileSync(join(codexHome, "config.toml"), options.modelConfig);
  const spawned: Array<AppServerChild> = [];

  const start = async (): Promise<RunningCodex> => {
    // A Codex installed with npm is a script that runs `node`, so `node`'s folder
    // is on the path too. Nothing else of the developer's environment is.
    const node = Bun.which("node");
    const child = spawnAppServer(buildAppServerCommand(codex!), {
      PATH: [dirname(codex!), ...(node === null ? [] : [dirname(node)]), "/usr/bin", "/bin"].join(
        ":",
      ),
      HOME: root,
      CODEX_HOME: codexHome,
      HERCULE_TOKEN: options.sessionToken,
      HERCULE_CODEX_FIXTURE_KEY: "dummy-local-key",
    });
    spawned.push(child);
    // Read to the end, so a full pipe never holds Codex up.
    void Array.fromAsync(child.stderr);

    const notifications: Array<NotificationFrame> = [];
    const rpc = makeRpc(child, {
      onServerRequest: (frame) =>
        rpc.answer(frame.id, {
          error: { message: `this test does not handle ${frame.method}` },
        }),
      onNotification: (frame) => void notifications.push(frame),
      onWarning: () => undefined,
    });
    Effect.runFork(rpc.pump);
    /** Sends a request and returns its result, or fails the test with Codex's error. */
    const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
      Effect.runPromise(
        Effect.mapError(
          rpc.request(method, params),
          (error) => new Error(`${method} failed: ${error.message}`),
        ),
      ) as Promise<Record<string, unknown>>;

    await request("initialize", {
      clientInfo: { name: "hercule-test", title: null, version: "0.0.0" },
      capabilities: { experimentalApi: false },
    });
    rpc.notify("initialized");

    // The thread's parameters as the adapter builds them for full access, with
    // its own MCP config. The gateway entry is given whether or not the
    // session's list holds a server: the gateway answers an empty list.
    const buildThreadParams = () =>
      ({
        cwd,
        model: "gpt-5.4",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
        config: buildMcpServerConfig(
          [{ name: GATEWAY_NAME, url: `${options.gatewayUrl}/mcp` }],
          "full-access",
        ),
      }) satisfies Partial<ThreadStartParams>;
    const readThreadId = (result: Record<string, unknown>): string =>
      (result["thread"] as { readonly id: string }).id;
    const countEndedTurns = (threadId: string): number =>
      notifications.filter(
        (frame) =>
          frame.method === "turn/completed" &&
          (frame.params as { readonly threadId?: string }).threadId === threadId,
      ).length;

    return {
      startThread: async () =>
        readThreadId(
          await request("thread/start", {
            ...buildThreadParams(),
            ephemeral: false,
          } satisfies ThreadStartParams),
        ),
      runTurn: async (threadId, prompt) => {
        const before = countEndedTurns(threadId);
        await request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
        } satisfies TurnStartParams);
        expect(
          await waitWithin(STEP_MS, () => countEndedTurns(threadId) > before),
          `the turn of "${prompt}" ended`,
        ).toBe(true);
      },
      readFinishedCalls: () =>
        notifications
          .filter(
            (frame) =>
              frame.method === "item/completed" &&
              (frame.params as { readonly item?: { readonly type?: string } }).item?.type ===
                "mcpToolCall",
          )
          .map((frame) => (frame.params as { readonly item: ReportedCall }).item),
    };
  };

  try {
    await body({ start });
  } finally {
    for (const child of spawned) await Effect.runPromise(stopChild(child));
    rmSync(root, { recursive: true, force: true });
  }
};

// -- The gateway -------------------------------------------------------------

/** What `withGateway` gives a test. */
interface Gateway extends ToolChangingGatewayRig {
  readonly upstream: FakeUpstream;
  readonly model: ReturnType<typeof startScriptedModel>;
}

/**
 * Runs `body` against a controller with a live Thread, a recording proxy in
 * front of the controller, a fake MCP server named `sentry` that lists `tools`,
 * and a stand-in model. The Thread's list holds `sentry` when `listed` is true.
 * Each call gets its own fake server, so a test counts calls from zero.
 */
const withGateway = async (
  options: { readonly listed: boolean; readonly tools?: ReadonlyArray<FakeTool> },
  body: (gateway: Gateway) => Promise<void>,
): Promise<void> => {
  const upstream = await startFakeUpstream({ tools: options.tools ?? [WHOAMI_TOOL] });
  const model = startScriptedModel(buildCallScript());
  try {
    await withGatewayRig(
      {
        upstream,
        profileName: "codex-gateway",
        serverNames: [SERVER_NAME],
        listed: options.listed ? [SERVER_NAME] : [],
        answerDiscoverLikeOlderServer: false,
      },
      (rig) => body({ ...rig, upstream, model }),
    );
  } finally {
    await model.stop();
    await upstream.stop();
  }
};

/** Runs `body` with a started Codex on a gateway whose session lists `sentry` when `listed` is true. */
const withCodexOnGateway = (
  options: { readonly listed: boolean; readonly tools?: ReadonlyArray<FakeTool> },
  body: (gateway: Gateway, home: CodexHome) => Promise<void>,
): Promise<void> =>
  withGateway(options, (gateway) =>
    withCodexHome(
      {
        gatewayUrl: gateway.gatewayUrl,
        sessionToken: gateway.sessionToken,
        modelConfig: gateway.model.config,
      },
      (home) => body(gateway, home),
    ),
  );

/** Waits until the gateway has received a request of `rpcMethod` after the first `after` requests. */
const waitForRequest = (
  proxy: RecordingProxy,
  rpcMethod: string,
  after = 0,
  accept: (one: (typeof proxy.seen)[number]) => boolean = () => true,
): Promise<boolean> =>
  waitWithin(STEP_MS, () => requestsOf(proxy.seen.slice(after), rpcMethod).some(accept));

describe.skipIf(codex === undefined)("the real Codex on the MCP Gateway", () => {
  it("initializes on the older era, lists the session's tools as <server>__<tool> and calls one upstream once", async () => {
    await withCodexOnGateway({ listed: true }, async (rig, home) => {
      const running = await home.start();
      const threadId = await running.startThread();
      await running.runTurn(threadId, `call ${WHOAMI}`);

      // The handshake: initialize, then initialized, the GET stream and the list, each on the MCP session initialize made.
      const [initialize] = requestsOf(rig.proxy.seen, "initialize");
      expect(OLDER_ERA_REVISIONS, "the revision Codex asked for").toContain(
        initialize!.initializeRevision,
      );
      expect(describeRequest(initialize!)).toBe("POST initialize no-revision no-session 200");
      const mcpSessionId = initialize!.answeredSessionId!;
      expect(mcpSessionId).not.toBeNull();
      // Codex opens the GET stream on its own schedule, so the turn can end before the gateway has
      // answered it, and it can come before or after the first list. Wait for the stream, and check
      // only the order the protocol fixes: initialize, then initialized, then the GET stream.
      expect(
        await waitForRequest(rig.proxy, "GET", 0, (one) => one.status === 200),
        "the GET stream is open",
      ).toBe(true);
      const methods = rig.proxy.seen.map((one) =>
        one.httpMethod === "GET" ? "GET" : one.rpcMethod,
      );
      expect(methods.slice(0, 2)).toEqual(["initialize", "notifications/initialized"]);
      expect(methods.indexOf("GET")).toBeGreaterThan(1);
      for (const method of ["notifications/initialized", "GET", "tools/list", "tools/call"]) {
        const [one] = requestsOf(rig.proxy.seen, method);
        expect(one!.sessionId, method).toBe(mcpSessionId);
        expect(one!.protocolVersion, method).toBe(initialize!.initializeRevision);
      }
      expect(requestsOf(rig.proxy.seen, "server/discover")).toEqual([]);

      // The model is shown the tool under the gateway's name, and the call reaches the server once.
      expect(readOfferedTools(rig.model.requests)).toEqual([WHOAMI]);
      expect(requestsOf(rig.proxy.seen, "tools/call").map((one) => one.tool)).toEqual([WHOAMI]);
      expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);
      expect(readCallOutput(rig.model.requests, "call-1")).toContain("hello");
      expect(running.readFinishedCalls().map((one) => [one.server, one.tool, one.status])).toEqual([
        [GATEWAY_NAME, WHOAMI, "completed"],
      ]);
    });
  }, 120_000);

  it("lists again when a server is added to the Thread, and calls the new tool once", async () => {
    await withCodexOnGateway({ listed: false }, async (rig, home) => {
      const running = await home.start();
      const threadId = await running.startThread();
      // Codex connects when the thread opens, and the gateway lists no tool yet.
      expect(await waitForRequest(rig.proxy, "GET", 0, (one) => one.status === 200)).toBe(true);
      expect(await waitForRequest(rig.proxy, "tools/list")).toBe(true);
      const [get] = requestsOf(rig.proxy.seen, "GET");
      const changesBefore = countListChanged([get!]);

      await rig.setList([SERVER_NAME]);
      expect(
        await waitWithin(STEP_MS, () => countListChanged([get!]) > changesBefore),
        "list_changed on the GET stream",
      ).toBe(true);

      // The first list was empty, so the model can be offered the tool only if Codex listed again.
      await running.runTurn(threadId, `call ${WHOAMI}`);
      expect(readOfferedTools(rig.model.requests)).toEqual([WHOAMI]);
      expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);
      expect(readCallOutput(rig.model.requests, "call-1")).toContain("hello");
    });
  }, 120_000);

  it("refuses a call under the name of a server taken out of the Thread's list, and calls nothing upstream", async () => {
    await withCodexOnGateway({ listed: true }, async (rig, home) => {
      const running = await home.start();
      const threadId = await running.startThread();
      await running.runTurn(threadId, `call ${WHOAMI}`);
      expect(readUpstreamCalls(rig.upstream)).toHaveLength(1);

      // Codex re-reads its list as soon as it hears of a change, and then refuses the call itself, never
      // reaching the gateway. So the notification is held back, as one that is still on its way: Codex
      // keeps the list it has and sends the call that the gateway must refuse.
      rig.proxy.withholdListChanged(true);
      const [get] = requestsOf(rig.proxy.seen, "GET");
      const changesBefore = countListChanged([get!]);
      await rig.setList([]);
      expect(
        await waitWithin(STEP_MS, () => countListChanged([get!]) > changesBefore),
        "the gateway sent list_changed",
      ).toBe(true);
      await running.runTurn(threadId, `call ${WHOAMI}`);

      const [, refused] = requestsOf(rig.proxy.seen, "tools/call");
      expect(describeRequest(refused!)).toBe(
        `POST tools/call ${refused!.protocolVersion} session 200`,
      );
      expect(refused!.tool).toBe(WHOAMI);
      expect(running.readFinishedCalls().map((one) => one.status)).toEqual(["completed", "failed"]);
      expect(readUpstreamCalls(rig.upstream)).toHaveLength(1);
    });
  }, 120_000);

  it("opens a new MCP session and sends the call again after the gateway forgot the one it held", async () => {
    await withCodexOnGateway({ listed: true }, async (rig, home) => {
      const running = await home.start();
      const threadId = await running.startThread();
      await running.runTurn(threadId, `call ${WHOAMI}`);
      const forgotten = await rig.forgetMcpSession();

      const mark = rig.proxy.seen.length;
      await running.runTurn(threadId, `call ${WHOAMI}`);
      const after = rig.proxy.seen.slice(mark);

      // The call goes out first on the forgotten session and gets 404. Codex handshakes again, and sends
      // the same call on the new session before it lists the tools on that session.
      const [refused, , retried] = after.filter((one) =>
        ["tools/call", "initialize"].includes(one.rpcMethod),
      );
      expect(describeRequest(refused!)).toBe(
        `POST tools/call ${refused!.protocolVersion} session 404`,
      );
      expect(refused!.sessionId).toBe(forgotten);
      const [initialize] = requestsOf(after, "initialize");
      const newSession = initialize!.answeredSessionId!;
      expect(newSession).not.toBe(forgotten);
      expect(describeRequest(retried!)).toBe(
        `POST tools/call ${retried!.protocolVersion} session 200`,
      );
      expect(retried!.sessionId).toBe(newSession);
      for (const one of requestsOf(after, "tools/list").filter(
        (list) => list.sessionId === newSession,
      )) {
        expect(after.indexOf(one), "no list before the call on the new session").toBeGreaterThan(
          after.indexOf(retried!),
        );
      }

      // The gateway offered no name to the new MCP session, so the call sent before the list is refused
      // once (the accepted cost of offering names per MCP session, spec 21 section 3.4), and the one the
      // gateway answered with 404 never reached the server either.
      expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);
      expect(running.readFinishedCalls().map((one) => one.status)).toEqual(["completed", "failed"]);

      // The refusal told Codex's streams to list again, so the next call runs.
      await running.runTurn(threadId, `call ${WHOAMI}`);
      expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami", "whoami"]);
      expect(running.readFinishedCalls().map((one) => one.status)).toEqual([
        "completed",
        "failed",
        "completed",
      ]);
    });
  }, 120_000);

  it("calls a tool whose name has a hyphen and one whose name has a dot, each reaching its own upstream tool beside a tool that reads alike", async () => {
    const tools = [
      { name: "search_pages", description: `Searches [${SERVER_NAME}__search_pages]` },
      { name: "search-pages", description: `Searches [${SERVER_NAME}__search_pages_f33805]` },
      { name: "search.pages", description: `Searches [${SERVER_NAME}__search_pages_52ac82]` },
    ];
    await withCodexOnGateway({ listed: true, tools }, async (rig, home) => {
      const running = await home.start();
      const threadId = await running.startThread();
      const owners: ReadonlyArray<readonly [string, string]> = [
        [`${SERVER_NAME}__search_pages`, "search_pages"],
        [`${SERVER_NAME}__search_pages_f33805`, "search-pages"],
        [`${SERVER_NAME}__search_pages_52ac82`, "search.pages"],
      ];
      for (const [name, tool] of owners) {
        const before = readUpstreamCalls(rig.upstream).length;
        await running.runTurn(threadId, `call ${name}`);
        expect(
          requestsOf(rig.proxy.seen, "tools/call")
            .map((one) => one.tool)
            .at(-1),
          `the gateway was called as ${name}`,
        ).toBe(name);
        expect(
          readUpstreamCalls(rig.upstream)
            .slice(before)
            .map((one) => one.tool),
          name,
        ).toEqual([tool]);
      }
      expect(running.readFinishedCalls().map((one) => one.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
    });
  }, 120_000);

  // Records which shape a Codex gives a few hundred tools: Codex 0.171.0 offers all 300 inline for the model
  // used here. It defers every MCP tool behind tool search when its search tool is enabled, which depends on
  // the model and the feature flags. Either way the model calls one tool once.
  it("shows a few hundred tools to the model inline or behind tool search, and calls one of them once", async () => {
    const tools = Array.from({ length: 300 }, (_, number) => ({
      name: `tool${String(number).padStart(3, "0")}`,
      description: `Tool number ${String(number)}`,
    }));
    await withCodexOnGateway({ listed: true, tools }, async (rig, home) => {
      const running = await home.start();
      const threadId = await running.startThread();
      await running.runTurn(threadId, `call ${SERVER_NAME}__tool007`);

      const first = rig.model.requests[0]!;
      const inline = readGatewayToolEntries(first.body.tools).length;
      const hasToolSearch = first.body.tools.some((tool) => tool["type"] === "tool_search");
      expect(inline === 300 || (inline === 0 && hasToolSearch), "all inline, or none inline").toBe(
        true,
      );
      expect(readOfferedTools(rig.model.requests)).toContain(`${SERVER_NAME}__tool007`);
      expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["tool007"]);
      expect(readCallOutput(rig.model.requests, "call-1")).toContain("hello");
    });
  }, 120_000);
});

// -- A name Codex showed, and a twin that comes or goes -------------------------

/** The most a test of the twins takes: each runs one Codex process for its scenario. */
const TWIN_TEST_MS = 120_000;

/** What the model is shown of the twins: each name Codex shows, and the tool of the server it stands for. */
type ShownTwins = Readonly<Record<string, string>>;

/** What happened to one call of a name the model chose. */
interface TwinCall {
  /** The name the gateway received. */
  readonly sentToGateway: ReadonlyArray<string>;
  /** The tools of the server that ran. */
  readonly ranUpstream: ReadonlyArray<string>;
  /** Codex's report of the call, or `none` when it reported no call. */
  readonly status: string;
  /** What the model was sent back for the call. */
  readonly modelWasTold: string | undefined;
}

/** What one state of the server's tools showed and did. */
interface TwinStep {
  /** The tools of the server in this state, by their original names. */
  readonly listed: ReadonlyArray<string>;
  /** What the model was shown in this state. */
  readonly shown: ShownTwins;
  /** The call of the name the model chose in the first state. */
  readonly call: TwinCall;
}

/**
 * Starts Codex on a server that lists the tools of the first of `states`, and
 * looks at what the model is shown. The model then calls the name shown for
 * the tool `calledTool`. For each next state, the server's tools are changed,
 * the model is shown what Codex shows then, and the model calls the very same
 * name again. Returns one step for each state.
 */
const runTwinScenario = async (options: {
  readonly states: ReadonlyArray<ReadonlyArray<FakeTool>>;
  readonly calledTool: string;
}): Promise<{ readonly name: string; readonly steps: ReadonlyArray<TwinStep> }> => {
  let result: { name: string; steps: Array<TwinStep> } | undefined;
  await withCodexOnGateway({ listed: true, tools: options.states[0]! }, async (rig, home) => {
    const running = await home.start();
    const threadId = await running.startThread();
    expect(await waitForRequest(rig.proxy, "GET", 0, (one) => one.status === 200)).toBe(true);
    expect(await waitForRequest(rig.proxy, "tools/list")).toBe(true);
    await waitUntilQuiet(rig.proxy, 500);

    /** Runs a turn that calls nothing, and returns what the model is shown in it. */
    const look = async (): Promise<ShownTwins> => {
      const mark = rig.model.requests.length;
      await running.runTurn(threadId, "look");
      const shown = readShownTools([rig.model.requests[mark]!]);
      return Object.fromEntries(
        shown.map((tool) => [tool.name, /\[(.+)\]$/.exec(tool.description ?? "")?.[1] ?? "?"]),
      );
    };
    const callExactly = async (name: string): Promise<TwinCall> => {
      const gatewayMark = requestsOf(rig.proxy.seen, "tools/call").length;
      const upstreamMark = readUpstreamCalls(rig.upstream).length;
      const callsMark = running.readFinishedCalls().length;
      const requestsMark = rig.model.requests.length;
      await running.runTurn(threadId, `call exactly ${name}`);
      const outputs = rig.model.requests
        .slice(requestsMark)
        .flatMap((request) => request.body.input)
        .filter((item) => item["type"] === "function_call_output");
      return {
        modelWasTold: outputs.length === 0 ? undefined : JSON.stringify(outputs.at(-1)!["output"]),
        sentToGateway: requestsOf(rig.proxy.seen, "tools/call")
          .slice(gatewayMark)
          .map((one) => one.tool!),
        ranUpstream: readUpstreamCalls(rig.upstream)
          .slice(upstreamMark)
          .map((one) => one.tool!),
        status: running.readFinishedCalls().slice(callsMark)[0]?.status ?? "none",
      };
    };

    const first = await look();
    const name = Object.keys(first).find((shown) => first[shown] === options.calledTool)!;
    const steps: Array<TwinStep> = [
      {
        listed: options.states[0]!.map((tool) => tool.name),
        shown: first,
        call: await callExactly(name),
      },
    ];
    for (const tools of options.states.slice(1)) {
      const [get] = requestsOf(rig.proxy.seen, "GET");
      const changesBefore = countListChanged([get!]);
      await rig.replaceTools(tools);
      expect(
        await waitWithin(STEP_MS, () => countListChanged([get!]) > changesBefore),
        "list_changed on the GET stream",
      ).toBe(true);
      await waitUntilQuiet(rig.proxy, 1_000);
      const shown = await look();
      steps.push({ listed: tools.map((tool) => tool.name), shown, call: await callExactly(name) });
    }
    result = { name, steps };
  });
  return result!;
};

/** The gateway's name for `tool` of `sentry`. */
const buildGatewayName = (tool: string): string =>
  `${SERVER_NAME}${MCP_GATEWAY_TOOL_SEPARATOR}${tool}`;

/** The name of `search_pages`, which the gateway keeps as it is. */
const UNDERSCORE_NAME = buildGatewayName("search_pages");

/**
 * The name of `search-pages`: the hyphen becomes `_`, and the first six hex
 * characters of the SHA-256 of `search-pages` follow. The gateway keeps no
 * hyphen, so Codex has no `-` to fold into the name of `search_pages`.
 */
const HYPHEN_NAME = buildGatewayName("search_pages_f33805");

/** The name Codex shows, and the gateway sends, for each of the two tools. */
const NAMES: Readonly<Record<string, string>> = {
  search_pages: UNDERSCORE_NAME,
  "search-pages": HYPHEN_NAME,
};

/** What a call that reached `tool` through the gateway looks like. */
const ranCall = (tool: string) => ({
  sentToGateway: [NAMES[tool]!],
  ranUpstream: [tool],
  status: "completed",
});

/** What a call looks like when Codex refuses the name itself: nothing reaches the gateway and Codex reports no call. */
const REFUSED_BY_CODEX = { sentToGateway: [], ranUpstream: [], status: "none" };

/** Returns what each step showed and did, without the text Codex told the model. */
const summarizeSteps = (steps: ReadonlyArray<TwinStep>) =>
  steps.map(({ listed, shown, call }) => ({
    listed,
    shown,
    sentToGateway: call.sentToGateway,
    ranUpstream: call.ranUpstream,
    status: call.status,
  }));

/** The tools that Codex shows for a list of tools, each under the gateway's name. */
const buildShown = (listed: ReadonlyArray<string>): ShownTwins =>
  Object.fromEntries(listed.map((tool) => [NAMES[tool]!, tool]));

/**
 * Codex, 0.169 and 0.171, shows the model `_` for `-` and gives every tool
 * whose shown name has a twin a suffix of its own, worked out from the
 * current list alone. The gateway keeps no `-` in a name, so no two gateway
 * names look alike to Codex, and Codex shows each name as it is. A name the
 * model used therefore means the same tool in every state of the list: it
 * runs its own tool while that tool is listed, and Codex refuses it once the
 * tool is gone. It never runs the sibling tool, with no restart, as the
 * hyphen-keeping names did (spec 21 section 3.4).
 */
describe.skipIf(codex === undefined)(
  "a name the model already used never runs the other tool in Codex, when a twin with - or _ comes or goes",
  () => {
    for (const { title, states, calledTool } of TWIN_SCENARIOS) {
      it(
        `${title}: the model's name for ${calledTool} runs ${calledTool} while it is listed and is refused after`,
        async () => {
          const run = await runTwinScenario({
            states: states.map((listed) => listed.map(buildTwinTool)),
            calledTool,
          });
          expect(run.name).toBe(NAMES[calledTool]);
          expect(summarizeSteps(run.steps)).toEqual(
            states.map((listed) => ({
              listed,
              shown: buildShown(listed),
              ...(listed.includes(calledTool) ? ranCall(calledTool) : REFUSED_BY_CODEX),
            })),
          );
          for (const step of run.steps) {
            expect(
              step.call.ranUpstream.every((tool) => tool === calledTool),
              "no other tool ran",
            ).toBe(true);
            if (step.call.ranUpstream.length === 0) {
              expect(step.call.modelWasTold).toContain("unsupported call");
            }
          }
        },
        TWIN_TEST_MS,
      );
    }
  },
);
