/**
 * Runs the real Codex against the real MCP Gateway, to check what the spec
 * could only assume (spec 21 section 3.11): that Codex works on the older wire
 * era, sees `notifications/tools/list_changed` and lists again, opens a new MCP
 * session when the gateway answers 404 for the one it holds, and connects again
 * when a thread is resumed or forked.
 *
 * Nothing here is billed and no login is used. Codex starts the way the Codex
 * adapter starts it: `codex app-server --strict-config`, then `thread/start`,
 * `thread/resume` or `thread/fork` with the `config` that the adapter's own
 * `buildMcpServerConfig` builds, the session token in `HERCULE_TOKEN`, and an
 * environment built from nothing (a throwaway `HOME` and `CODEX_HOME`). The
 * model is a local stand-in for the Responses API that calls the tool a prompt
 * names, so no real model is reached.
 *
 * A recording proxy sits between Codex and the controller and keeps what the
 * gateway receives, as in `mcp-claude-code.integration.test.ts`.
 *
 * What this file does not check:
 *
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
import { describe, expect, it } from "vitest";
import {
  buildMcpServerConfig,
  supportsToolListChanged,
} from "../../../runner/src/harnesses/codex/mcp";
import { parseVersion } from "../../../runner/src/harnesses/codex/probe";
import {
  startScriptedModel,
  type ScriptedModelRequest,
} from "../../../runner/src/harnesses/codex/mock-model.testing";
import type {
  ThreadForkParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
} from "../../../runner/src/harnesses/codex/types";
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

const codex = process.env["HERCULE_CODEX_TEST_BINARY"] ?? Bun.which("codex") ?? undefined;

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

/**
 * Builds the model's script: a prompt `call <tool>` makes the model call that
 * tool of the gateway once, with the argument `hello`; any other request ends
 * the turn. The model calls the tool whether or not it was offered, which lets
 * a test send a call under a name the gateway no longer serves.
 */
const buildCallScript = () => {
  let calls = 0;
  return (request: ScriptedModelRequest) => {
    const tool = /call (\w+)/.exec(readPrompt(request.body.input.at(-1)))?.[1];
    if (tool === undefined) return undefined;
    return [
      {
        type: "function_call",
        namespace: `mcp__${GATEWAY_NAME}`,
        name: tool,
        call_id: `call-${String(++calls)}`,
        arguments: JSON.stringify({ text: "hello" }),
      },
    ];
  };
};

/** Returns the names of the gateway's tools that a model request offered. */
const readOfferedTools = (request: ScriptedModelRequest): ReadonlyArray<string> =>
  request.body.tools
    .filter((tool) => tool["name"] === `mcp__${GATEWAY_NAME}`)
    .flatMap((tool) =>
      (tool["tools"] as ReadonlyArray<{ readonly name: string }>).map((one) => one.name),
    );

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

/** One JSON-RPC message from `codex app-server`: a response, a notification or a request of its own. */
interface Frame {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message: string };
}

/** What a finished `mcpToolCall` item says about the call. */
interface ReportedCall {
  readonly server: string;
  readonly tool: string;
  readonly status: string;
  readonly error: { readonly message: string } | null;
}

/** A running `codex app-server`, and the questions a test can put to it. */
interface RunningCodex {
  /** The version Codex reports in its user agent, which decides what config the adapter sends. */
  readonly version: string | null;
  /** Opens a thread the way the adapter does and returns its id. */
  readonly startThread: () => Promise<string>;
  /** Resumes or forks a thread of an earlier process and returns the id of the thread that is open now. */
  readonly continueThread: (mode: "resume" | "fork", threadId: string) => Promise<string>;
  /** Sends a prompt and waits until the turn ends. */
  readonly runTurn: (threadId: string, prompt: string) => Promise<void>;
  /** Returns every MCP tool call item that has finished, oldest first. */
  readonly readFinishedCalls: () => ReadonlyArray<ReportedCall>;
  /** Stops the process by its id and waits until it has exited. */
  readonly stop: () => Promise<void>;
}

/** What `withCodexHome` makes: starts one `codex app-server` after another on the same `CODEX_HOME`. */
interface CodexHome {
  readonly start: () => Promise<RunningCodex>;
}

/**
 * Prepares a throwaway `HOME` and `CODEX_HOME` that point Codex at the stand-in
 * model, calls `body` with a way to start `codex app-server` processes on it,
 * then stops every process it started, by process id, and removes the folders.
 * A second process on the same home can resume a thread of the first.
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
  const running: Array<RunningCodex> = [];

  const start = async (): Promise<RunningCodex> => {
    // A Codex installed with npm is a script that runs `node`, so `node`'s folder
    // is on the path too. Nothing else of the developer's environment is.
    const node = Bun.which("node");
    const child = Bun.spawn(
      [codex!, "app-server", "--strict-config", "-c", "check_for_update_on_startup=false"],
      {
        env: {
          PATH: [
            dirname(codex!),
            ...(node === null ? [] : [dirname(node)]),
            "/usr/bin",
            "/bin",
          ].join(":"),
          HOME: root,
          CODEX_HOME: codexHome,
          HERCULE_TOKEN: options.sessionToken,
          HERCULE_CODEX_FIXTURE_KEY: "dummy-local-key",
        },
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    );

    const frames: Array<Frame> = [];
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.trim() !== "") frames.push(JSON.parse(line) as Frame);
        }
      }
    })();
    const write = async (message: unknown): Promise<void> => {
      await child.stdin.write(`${JSON.stringify(message)}\n`);
      await child.stdin.flush();
    };
    let nextId = 1;
    /** Sends a request and returns its result, or fails the test with Codex's error. */
    const request = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
      const id = nextId++;
      await write({ id, method, params });
      expect(
        await waitWithin(STEP_MS, () =>
          frames.some((frame) => frame.id === id && frame.method === undefined),
        ),
        `an answer to ${method}`,
      ).toBe(true);
      const answer = frames.find((frame) => frame.id === id && frame.method === undefined)!;
      if (answer.error !== undefined) throw new Error(`${method} failed: ${answer.error.message}`);
      return answer.result!;
    };

    const initialized = await request("initialize", {
      clientInfo: { name: "hercule-test", title: null, version: "0.0.0" },
      capabilities: { experimentalApi: false },
    });
    await write({ method: "initialized" });
    const version = parseVersion(initialized["userAgent"] as string);

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
          "approve",
          supportsToolListChanged(version),
        ),
      }) satisfies Partial<ThreadStartParams>;
    const readThreadId = (result: Record<string, unknown>): string =>
      (result["thread"] as { readonly id: string }).id;
    const countEndedTurns = (threadId: string): number =>
      frames.filter(
        (frame) => frame.method === "turn/completed" && frame.params?.["threadId"] === threadId,
      ).length;

    const started: RunningCodex = {
      version,
      startThread: async () =>
        readThreadId(
          await request("thread/start", {
            ...buildThreadParams(),
            ephemeral: false,
          } satisfies ThreadStartParams),
        ),
      continueThread: async (mode, threadId) =>
        readThreadId(
          await request(mode === "resume" ? "thread/resume" : "thread/fork", {
            threadId,
            ...buildThreadParams(),
          } satisfies ThreadResumeParams & ThreadForkParams),
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
        frames
          .filter(
            (frame) =>
              frame.method === "item/completed" &&
              (frame.params?.["item"] as { readonly type?: string } | undefined)?.type ===
                "mcpToolCall",
          )
          .map((frame) => frame.params!["item"] as ReportedCall),
      stop: async () => {
        if (child.exitCode !== null) return;
        child.kill();
        await child.exited;
      },
    };
    running.push(started);
    return started;
  };

  try {
    await body({ start });
  } finally {
    for (const one of running) await one.stop();
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

/** The version of the Codex under test, read from `codex --version` (`codex-cli 0.169.0`). */
const codexVersion =
  codex === undefined
    ? null
    : (/\d+\.\d+\.\d+/.exec(Bun.spawnSync([codex, "--version"]).stdout.toString())?.[0] ?? null);

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
      expect(rig.proxy.seen.map((one) => one.rpcMethod).slice(0, 3)).toEqual([
        "initialize",
        "notifications/initialized",
        "-",
      ]);
      expect(requestsOf(rig.proxy.seen, "GET")[0]!.status).toBe(200);
      for (const method of ["notifications/initialized", "GET", "tools/list", "tools/call"]) {
        const [one] = requestsOf(rig.proxy.seen, method);
        expect(one!.sessionId, method).toBe(mcpSessionId);
        expect(one!.protocolVersion, method).toBe(initialize!.initializeRevision);
      }
      expect(requestsOf(rig.proxy.seen, "server/discover")).toEqual([]);

      // The model is shown the tool under the gateway's name, and the call reaches the server once.
      expect(readOfferedTools(rig.model.requests[0]!)).toEqual([WHOAMI]);
      expect(requestsOf(rig.proxy.seen, "tools/call").map((one) => one.tool)).toEqual([WHOAMI]);
      expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);
      expect(readCallOutput(rig.model.requests, "call-1")).toContain("hello");
      expect(running.readFinishedCalls().map((one) => [one.server, one.tool, one.status])).toEqual([
        [GATEWAY_NAME, WHOAMI, "completed"],
      ]);
    });
  }, 120_000);

  // An older Codex does not re-read its tool list, and the adapter warns the user instead.
  it.skipIf(!supportsToolListChanged(codexVersion))(
    "lists again when a server is added to the Thread, and calls the new tool once",
    async () => {
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
        expect(readOfferedTools(rig.model.requests[0]!)).toEqual([WHOAMI]);
        expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);
        expect(readCallOutput(rig.model.requests, "call-1")).toContain("hello");
      });
    },
    120_000,
  );

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

      expect(readOfferedTools(rig.model.requests.at(-1)!), "Codex still held the old list").toEqual(
        [WHOAMI],
      );
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

      // Each call reached the server once, and the one the gateway answered with 404 never did.
      expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami", "whoami"]);
      expect(running.readFinishedCalls().map((one) => one.status)).toEqual([
        "completed",
        "completed",
      ]);
    });
  }, 120_000);

  it.each(["resume", "fork"] as const)(
    "connects, lists and calls again after a new process did thread/%s with the config sent again",
    async (mode) => {
      await withCodexOnGateway({ listed: true }, async (rig, home) => {
        const first = await home.start();
        const threadId = await first.startThread();
        await first.runTurn(threadId, `call ${WHOAMI}`);
        await first.stop();
        const mark = rig.proxy.seen.length;

        // Codex saves no MCP server with a thread, so it connects only because the config is sent again.
        const second = await home.start();
        const continued = await second.continueThread(mode, threadId);
        expect(continued === threadId, "a fork is a new thread").toBe(mode === "resume");
        expect(await waitForRequest(rig.proxy, "initialize", mark)).toBe(true);
        expect(await waitForRequest(rig.proxy, "tools/list", mark)).toBe(true);

        await second.runTurn(continued, `call ${WHOAMI}`);
        expect(readOfferedTools(rig.model.requests.at(-1)!)).toEqual([WHOAMI]);
        expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual([
          "whoami",
          "whoami",
        ]);
        expect(second.readFinishedCalls().map((one) => one.status)).toEqual(["completed"]);
      });
    },
    120_000,
  );

  // Recorded, not designed for: Codex 0.169.0 and 0.171.0 offer all 300 tools directly in the gateway's
  // namespace and defer none behind tool search. A Codex that defers them fails this test, and the
  // stand-in model then has to answer with a `tool_search_call` before it can call a tool.
  it("offers a few hundred tools directly to the model and calls one of them once", async () => {
    const tools = Array.from({ length: 300 }, (_, number) => ({
      name: `tool${String(number).padStart(3, "0")}`,
      description: `Tool number ${String(number)}`,
    }));
    await withCodexOnGateway({ listed: true, tools }, async (rig, home) => {
      const running = await home.start();
      const threadId = await running.startThread();
      await running.runTurn(threadId, `call ${SERVER_NAME}__tool007`);

      const offered = readOfferedTools(rig.model.requests[0]!);
      expect(offered).toHaveLength(300);
      expect(offered).toContain(`${SERVER_NAME}__tool007`);
      expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["tool007"]);
      expect(readCallOutput(rig.model.requests, "call-1")).toContain("hello");
    });
  }, 120_000);
});
