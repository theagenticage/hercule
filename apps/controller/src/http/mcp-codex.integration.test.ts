/**
 * Runs the real Codex against the real MCP Gateway, to check what the spec
 * could only assume (spec 21 section 3.11): that Codex works on the older wire
 * era, sees `notifications/tools/list_changed` and lists again, opens a new MCP
 * session when the gateway answers 404 for the one it holds. Resuming and
 * forking a thread is checked beside the adapter, in
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
 *   run, and its `reboot` repeats only the boot steps inside the same process,
 *   so the gateway keeps the names it has sent. A test of the call that follows
 *   a restart (the gateway refuses it once with "list the tools again", spec 21
 *   section 3.4, and nothing reaches the server) needs a controller that can be
 *   stopped and started over one database.
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
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import { createProfile, spawnThreadUnder } from "../sessions/testing";
import {
  createServers,
  eventually,
  readServer,
  startFakeUpstream,
  type FakeTool,
  type FakeUpstream,
} from "../mcp-servers/testing";
import {
  countListChanged,
  describeRequest,
  requestsOf,
  startRecordingProxy,
  type RecordingProxy,
} from "./mcp-recording-proxy.testing";
import { send, waitWithin } from "./testing";
import { withFleet } from "../workspaces/testing";

const codex = findCodexTestBinary();

/** The most one step of these tests waits for Codex, which is a separate process that starts slowly. */
const STEP_MS = 30_000;

/** The revisions of the older era, which Codex asks `initialize` for. */
const OLDER_ERA_REVISIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];

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

/** Returns the names of the gateway's tools in the namespace entries among `entries`. */
const readGatewayTools = (entries: ReadonlyArray<ToolEntry>): ReadonlyArray<string> =>
  entries
    .filter((entry) => entry["name"] === `mcp__${GATEWAY_NAME}`)
    .flatMap((entry) =>
      (entry["tools"] as ReadonlyArray<{ readonly name: string }>).map((one) => one.name),
    );

/**
 * Returns the names of the gateway's tools the model has been shown in
 * `requests`, once each. A Codex shows them in one of two shapes, and the
 * request itself says which:
 *
 * - inline, as a `mcp__tools` namespace in the request's `tools`;
 * - deferred, as the result of a `tool_search_call`, which comes back as a
 *   `tool_search_output` item in the request's input. Such a request has a
 *   `tool_search` tool and no inline namespace.
 */
const readOfferedTools = (requests: ReadonlyArray<ScriptedModelRequest>): ReadonlyArray<string> => [
  ...new Set(
    requests.flatMap((request) => [
      ...readGatewayTools(request.body.tools),
      ...readGatewayTools(
        request.body.input
          .filter((item) => item["type"] === "tool_search_output")
          .flatMap((item) => item["tools"] as ReadonlyArray<ToolEntry>),
      ),
    ]),
  ),
];

/**
 * Builds the model's script. A prompt `call <tool>` makes the model call that
 * tool of the gateway once, with the argument `hello`. When Codex has not shown
 * the model the tool and offers a `tool_search` tool, the model searches for
 * the tool first and calls it only if the search returned it. Any other request
 * ends the turn.
 */
const buildCallScript = () => {
  let calls = 0;
  let searches = 0;
  let searchedFor: string | undefined;
  const buildCall = (tool: string) => ({
    type: "function_call",
    namespace: `mcp__${GATEWAY_NAME}`,
    name: tool,
    call_id: `call-${String(++calls)}`,
    arguments: JSON.stringify({ text: "hello" }),
  });
  return (request: ScriptedModelRequest) => {
    const last = request.body.input.at(-1);
    const wanted = /call (\w+)/.exec(readPrompt(last))?.[1];
    if (wanted !== undefined) {
      const canSearch = request.body.tools.some((tool) => tool["type"] === "tool_search");
      if (canSearch && !readOfferedTools([request]).includes(wanted)) {
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
      return [buildCall(wanted)];
    }
    if (last?.["type"] === "tool_search_output" && searchedFor !== undefined) {
      const found = readGatewayTools(last["tools"] as ReadonlyArray<ToolEntry>);
      return found.includes(searchedFor) ? [buildCall(searchedFor)] : undefined;
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
interface Gateway {
  readonly proxy: RecordingProxy;
  /** The address Codex is given: the recording proxy in front of the controller. */
  readonly gatewayUrl: string;
  readonly sessionToken: string;
  readonly upstream: FakeUpstream;
  readonly model: ReturnType<typeof startScriptedModel>;
  /** Puts the `sentry` server in the Thread's list, or takes it out. */
  readonly setListed: (listed: boolean) => Promise<void>;
  /**
   * Makes the gateway forget the MCP session that Codex holds, as a restart
   * does for every session, and returns the id of the session that was
   * forgotten. Codex is not told.
   */
  readonly forgetMcpSession: () => Promise<string>;
}

const WHOAMI_TOOL: FakeTool = {
  name: "whoami",
  description: "Returns the user the server acts as",
};

/** Returns the `tools/call` requests the fake upstream received. */
const readUpstreamCalls = (upstream: FakeUpstream) =>
  upstream.requests.filter((one) => one.method === "tools/call");

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
    await withFleet(
      async (arranged) => {
        const controller = {
          harness: arranged.harness,
          base: arranged.harness.base,
          token: arranged.token,
        };
        const [sentry] = await createServers(controller, [SERVER_NAME]);
        await eventually(
          () => readServer(controller, sentry!.id),
          (record) => record.status === "ready",
        );
        const profile = await createProfile(arranged, "codex-gateway", ["mcp.use"]);
        const thread = await spawnThreadUnder(arranged, profile, {
          mcpServerIds: options.listed ? [sentry!.id] : [],
        });
        const proxy = startRecordingProxy(arranged.harness.base, {
          answerDiscoverLikeOlderServer: false,
        });
        try {
          await body({
            proxy,
            gatewayUrl: proxy.url,
            sessionToken: thread.token,
            upstream,
            model,
            setListed: async (listed) => {
              const response = await send(
                "PATCH",
                arranged.harness.base,
                `/api/v1/sessions/${thread.session.id}`,
                { body: { mcpServerIds: listed ? [sentry!.id] : [] }, token: arranged.token },
              );
              expect(response.status).toBe(200);
            },
            forgetMcpSession: async () => {
              const [initialize] = requestsOf(proxy.seen, "initialize");
              const [list] = requestsOf(proxy.seen, "tools/list");
              const gone = await fetch(`${proxy.url}/mcp`, {
                method: "DELETE",
                headers: {
                  authorization: `Bearer ${thread.token}`,
                  "mcp-session-id": initialize!.answeredSessionId!,
                  "mcp-protocol-version": list!.protocolVersion!,
                },
              });
              expect(gone.status).toBe(204);
              return initialize!.answeredSessionId!;
            },
          });
        } finally {
          await proxy.stop();
        }
      },
      {
        plugins: [buildMcpServerPlugin("acme", { server: buildDeskMcpServer("acme", upstream) })],
      },
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

      await rig.setListed(true);
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
      await rig.setListed(false);
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

  it("opens a new MCP session and is refused once on its first call after the gateway forgot the one it held", async () => {
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

      // The gateway refuses the first call on a session opened after it lost one, because Codex may
      // hold a name from before. The refusal never reached the server.
      expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);
      expect(running.readFinishedCalls().map((one) => one.status)).toEqual(["completed", "failed"]);

      // The next call on that session is judged as any other, and runs.
      await running.runTurn(threadId, `call ${WHOAMI}`);
      expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami", "whoami"]);
      expect(running.readFinishedCalls().map((one) => one.status)).toEqual([
        "completed",
        "failed",
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
      const inline = readGatewayTools(first.body.tools).length;
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
