/**
 * Runs the real Claude Code against the real MCP Gateway, to check what the
 * spec could only assume (spec 21 section 3.11): that the CLI works on both
 * wire eras, that it sees `notifications/tools/list_changed` on each, and that
 * it opens a new MCP session when the gateway answers 404 for the one it
 * holds, as after a controller restart.
 *
 * Nothing here is billed and no login is used. The CLI starts the way the
 * Claude Code adapter starts it: the adapter's own `mcpServers` entry
 * (`buildMcpServerEntries`), the session token in `HERCULE_TOKEN`,
 * `--strict-mcp-config`, a throwaway config directory and
 * `MCP_DISCOVERY_CACHE=0`, and an environment built from nothing. Two things
 * differ from production, each with its reason where it is set: an allow rule
 * for the gateway's tools and `ENABLE_TOOL_SEARCH=false`. Its input carries no
 * prompt until a test sends one, so it connects to its MCP servers and calls no
 * model; `mcp_status` asks it what it lists. The one test that needs the CLI to
 * send a `tools/call` sends a prompt to a local stand-in for the Messages API,
 * which answers with that tool call.
 *
 * A second group runs the CLI against servers added by address, one with no
 * sign-in and one with a token, and checks that the token is in neither the
 * messages the CLI wrote to its stdout nor any file under its config folders.
 *
 * A recording proxy sits between the CLI and the controller and keeps what the
 * gateway receives: methods, revisions, MCP session ids, and the messages the
 * gateway sends on each stream. Skipped when no `claude` binary is found, which
 * includes CI: no CI job installs one, so this file runs on a developer's
 * machine only.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Plugin } from "@hercule/plugin-host";
import { buildMcpServerEntries } from "../../../runner/src/harnesses/claude-code";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import { createProfile, spawnThreadUnder, type Arranged } from "../sessions/testing";
import {
  createServers,
  eventually,
  readServer,
  startFakeUpstream,
  type FakeUpstream,
} from "../mcp-servers/testing";
import {
  countListChanged,
  describeRequest,
  requestsOf,
  startRecordingProxy,
  waitUntilQuiet,
  type RecordingProxy,
} from "./mcp-recording-proxy.testing";
import { post, send, waitWithin } from "./testing";
import { withFleet } from "../workspaces/testing";

const claude = Bun.which("claude") ?? undefined;

/** The most one step of these tests waits for the CLI, which is a separate process that starts slowly. */
const STEP_MS = 20_000;

let PLUGINS: ReadonlyArray<Plugin>;

// -- A stand-in for the Messages API -------------------------------------------

/**
 * Starts a local stand-in for the Anthropic Messages API and returns its
 * address. The CLI is pointed at it, so no real model is reached. It answers
 * a request with a call of the first of `tools` that has no result in the
 * conversation yet, provided the request offers that tool, so each tool is
 * called once and in order. Every other request gets the text "done".
 */
const startStandInModel = (
  tools: ReadonlyArray<string>,
): { readonly url: string; readonly stop: () => void } => {
  let toolUses = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/v1/messages")) {
        return Response.json({});
      }
      const body = (await request.json()) as {
        readonly model: string;
        readonly tools?: ReadonlyArray<{ readonly name: string }>;
        readonly messages: unknown;
      };
      const resultsSoFar = JSON.stringify(body.messages).split('"type":"tool_result"').length - 1;
      const tool = tools[resultsSoFar];
      const callsTool = tool !== undefined && (body.tools ?? []).some((one) => one.name === tool);
      const block = callsTool
        ? [
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: `toolu_${String(++toolUses)}`,
                name: tool,
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: JSON.stringify({ text: "hello" }) },
            },
          ]
        : [
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
          ];
      const events: ReadonlyArray<readonly [string, unknown]> = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: body.model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
        ...block.map((event) => [event.type, event] as const),
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: callsTool ? "tool_use" : "end_turn" },
            usage: { output_tokens: 5 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ];
      return new Response(
        events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    stop: () => void server.stop(true),
  };
};

// -- The real Claude Code --------------------------------------------------------

/** What `mcp_status` reports for the gateway's entry. */
interface ReportedServer {
  readonly status: string;
  readonly tools: ReadonlyArray<string>;
}

/** A running Claude Code, and the questions a test can put to it. */
interface RunningClaude {
  /** Asks the CLI what it lists for the `tools` entry now. */
  readonly readStatus: () => Promise<ReportedServer>;
  /** Sends a prompt, which the stand-in model answers with a call of the tool, and returns that call's result text. */
  readonly runToolCall: () => Promise<ToolCallResult>;
  /** Sends a prompt, which the stand-in model answers with `count` calls, and returns their results in order. */
  readonly runToolCalls: (count: number) => Promise<ReadonlyArray<ToolCallResult>>;
  /**
   * Returns everything the CLI has put out so far as text: the messages it
   * wrote to its output, and the content of every file under its folders.
   */
  readonly readTraces: () => { readonly output: string; readonly files: string };
}

interface ToolCallResult {
  readonly isError: boolean;
  readonly text: string;
}

interface ToolResultBlock {
  readonly type: string;
  readonly is_error?: boolean;
  readonly content?: string | ReadonlyArray<{ readonly text?: string }>;
}

/**
 * Starts the real CLI with the gateway at `gatewayUrl` as its `tools` server,
 * the way the Claude Code adapter does, and its Messages API at `modelUrl`.
 * Calls `body`, then stops the CLI by its process id and removes its folders.
 */
const withClaude = async (
  options: {
    readonly gatewayUrl: string;
    readonly sessionToken: string;
    readonly modelUrl: string;
  },
  body: (running: RunningClaude) => Promise<void>,
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "hercule-claude-gateway-"));
  const configDir = join(root, "config");
  const cwd = join(root, "cwd");
  mkdirSync(configDir);
  mkdirSync(cwd);
  // The adapter's own entry: its header names `${HERCULE_TOKEN}`, and the runner puts the token there.
  const mcpConfig = {
    mcpServers: buildMcpServerEntries([{ name: "tools", url: `${options.gatewayUrl}/mcp` }]),
  };
  const child = Bun.spawn(
    [
      claude!,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(mcpConfig),
      // Production differs here on purpose. The adapter asks the user through
      // `canUseTool`; nobody is here to answer, and without this rule the CLI
      // refuses the call ("requested permissions ... but you haven't granted it").
      "--allowedTools",
      "mcp__tools",
    ],
    {
      // Built from nothing, so no login or setting of the developer's reaches the CLI.
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: root,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: "sk-ant-placeholder",
        ANTHROPIC_BASE_URL: options.modelUrl,
        DISABLE_AUTOUPDATER: "1",
        MCP_DISCOVERY_CACHE: "0",
        HERCULE_TOKEN: options.sessionToken,
        // Production differs here on purpose. With tool search on, the CLI
        // sends the gateway's tools only as deferred names, and the stand-in
        // model, which cannot search, never sees one to call.
        ENABLE_TOOL_SEARCH: "false",
      },
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );

  // Every message the CLI writes, so a test can wait for the answer it needs.
  const messages: Array<{ readonly type?: string; readonly [key: string]: unknown }> = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim() !== "") messages.push(JSON.parse(line) as (typeof messages)[number]);
      }
    }
  })();
  const write = async (message: unknown): Promise<void> => {
    await child.stdin.write(`${JSON.stringify(message)}\n`);
    await child.stdin.flush();
  };

  let nextRequest = 1;
  const readStatus = async (): Promise<ReportedServer> => {
    const requestId = `status-${String(nextRequest++)}`;
    await write({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "mcp_status" },
    });
    const answered = (): unknown =>
      messages.find(
        (message) =>
          message.type === "control_response" &&
          (message["response"] as { request_id?: string }).request_id === requestId,
      );
    expect(await waitWithin(STEP_MS, () => answered() !== undefined), "mcp_status answered").toBe(
      true,
    );
    const { response } = answered() as {
      response: {
        response: {
          mcpServers: ReadonlyArray<{
            name: string;
            status: string;
            tools?: ReadonlyArray<{ name: string }>;
          }>;
        };
      };
    };
    const server = response.response.mcpServers.find((one) => one.name === "tools");
    return {
      status: server?.status ?? "absent",
      tools: (server?.tools ?? []).map((tool) => tool.name),
    };
  };

  const readToolResults = (): ReadonlyArray<ToolResultBlock> =>
    messages
      .filter((message) => message.type === "user")
      .flatMap((message) => {
        const content = (message["message"] as { content?: unknown }).content;
        return Array.isArray(content) ? (content as ReadonlyArray<ToolResultBlock>) : [];
      })
      .filter((block) => block.type === "tool_result");
  const runToolCalls = async (count: number): Promise<ReadonlyArray<ToolCallResult>> => {
    const before = readToolResults().length;
    await write({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Call the tool." }] },
      parent_tool_use_id: null,
    });
    expect(
      await waitWithin(STEP_MS, () => readToolResults().length >= before + count),
      `${String(count)} tool result(s)`,
    ).toBe(true);
    return readToolResults()
      .slice(before, before + count)
      .map((result) => ({
        isError: result.is_error === true,
        text:
          typeof result.content === "string"
            ? result.content
            : (result.content ?? []).map((part) => part.text ?? "").join(""),
      }));
  };
  const runToolCall = async (): Promise<ToolCallResult> => (await runToolCalls(1))[0]!;

  const readTraces = (): { output: string; files: string } => {
    const files: Array<string> = [];
    for (const relative of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      const path = join(root, relative);
      try {
        if (statSync(path).isFile()) files.push(readFileSync(path, "utf8"));
      } catch {
        // The CLI removes its temporary files while it runs: one that is gone holds nothing to find.
      }
    }
    return { output: JSON.stringify(messages), files: files.join("\n") };
  };

  try {
    await body({ readStatus, runToolCall, runToolCalls, readTraces });
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
};

/** What a test needs to reach the gateway as the CLI does. */
interface GatewayRig {
  readonly proxy: RecordingProxy;
  readonly gatewayUrl: string;
  readonly sessionToken: string;
  readonly modelUrl: string;
  /** The session whose list the gateway serves. */
  readonly sessionId: string;
}

/**
 * Spawns a live Thread whose list holds the servers `serverIds`, puts the
 * recording proxy in front of the controller and a stand-in model that calls
 * `tools` in order, and runs `body`. Stops the proxy and the stand-in after.
 */
const withThreadOnGateway = async (
  arranged: Arranged,
  options: {
    readonly serverIds: ReadonlyArray<string>;
    readonly tools: ReadonlyArray<string>;
    readonly answerDiscoverLikeOlderServer: boolean;
  },
  body: (rig: GatewayRig) => Promise<void>,
): Promise<void> => {
  const profile = await createProfile(arranged, "claude-gateway", ["mcp.use"]);
  const thread = await spawnThreadUnder(arranged, profile, {
    mcpServerIds: [...options.serverIds],
  });
  const proxy = startRecordingProxy(arranged.harness.base, options);
  const model = startStandInModel(options.tools);
  try {
    await body({
      proxy,
      gatewayUrl: proxy.url,
      sessionToken: thread.token,
      modelUrl: model.url,
      sessionId: thread.session.id,
    });
  } finally {
    model.stop();
    await proxy.stop();
  }
};

/**
 * Runs `body` against a controller with a live Thread whose list holds server
 * `alpha`, a second server `bravo` ready to be added, the recording proxy in
 * front of the controller, and a stand-in model.
 */
const withGateway = (
  options: { readonly answerDiscoverLikeOlderServer: boolean },
  body: (
    rig: GatewayRig & {
      readonly setList: (names: ReadonlyArray<"alpha" | "bravo">) => Promise<void>;
    },
  ) => Promise<void>,
): Promise<void> =>
  withFleet(
    async (arranged) => {
      const controller = {
        harness: arranged.harness,
        base: arranged.harness.base,
        token: arranged.token,
      };
      const [alpha, bravo] = await createServers(controller, ["alpha", "bravo"]);
      for (const server of [alpha!, bravo!]) {
        await eventually(
          () => readServer(controller, server.id),
          (record) => record.status === "ready",
        );
      }
      const ids = { alpha: alpha!.id, bravo: bravo!.id };
      await withThreadOnGateway(
        arranged,
        {
          serverIds: [alpha!.id],
          tools: ["mcp__tools__alpha__echo"],
          answerDiscoverLikeOlderServer: options.answerDiscoverLikeOlderServer,
        },
        (rig) =>
          body({
            ...rig,
            setList: async (names) => {
              const response = await send(
                "PATCH",
                arranged.harness.base,
                `/api/v1/sessions/${rig.sessionId}`,
                {
                  body: { mcpServerIds: names.map((name) => ids[name]) },
                  token: arranged.token,
                },
              );
              expect(response.status).toBe(200);
            },
          }),
      );
    },
    { plugins: PLUGINS },
  );

const ALPHA_TOOLS = ["alpha__echo", "alpha__get_issue_details"];
const ALL_TOOLS = [...ALPHA_TOOLS, "bravo__echo", "bravo__get_issue_details"];

/** Waits until the CLI lists exactly `tools` for the gateway's entry. */
const waitForTools = (
  running: RunningClaude,
  tools: ReadonlyArray<string>,
): Promise<ReportedServer> =>
  eventually(
    () => running.readStatus(),
    (reported) => reported.status === "connected" && reported.tools.join() === tools.join(),
  );

describe.skipIf(claude === undefined)("the real Claude Code on the MCP Gateway", () => {
  let upstream: FakeUpstream;

  beforeAll(async () => {
    upstream = await startFakeUpstream({
      tools: [
        { name: "echo", description: "Echoes its text" },
        { name: "get-issue.details", description: "Reads an issue" },
      ],
    });
    PLUGINS = [buildMcpServerPlugin("acme", { server: buildDeskMcpServer("acme", upstream) })];
  });

  afterAll(async () => {
    await upstream.stop();
  });

  it("works on the 2026-07-28 path and lists again when the gateway sends list_changed on subscriptions/listen", async () => {
    await withGateway({ answerDiscoverLikeOlderServer: false }, async (rig) => {
      await withClaude(rig, async (running) => {
        await waitForTools(running, ALPHA_TOOLS);

        // The CLI tries the new era first, and the gateway answers it, so no MCP session is ever opened.
        const afterStart = rig.proxy.seen.map(describeRequest);
        expect(afterStart[0]).toBe("POST server/discover 2026-07-28 no-session 200");
        expect(afterStart).toContain("POST subscriptions/listen 2026-07-28 no-session 200");
        expect(afterStart).toContain("POST tools/list 2026-07-28 no-session 200");
        expect(requestsOf(rig.proxy.seen, "initialize")).toEqual([]);
        expect(rig.proxy.seen.every((one) => one.sessionId === null)).toBe(true);
        const [listen] = requestsOf(rig.proxy.seen, "subscriptions/listen");
        expect(listen?.streamed[0]).toBe("notifications/subscriptions/acknowledged");
        const listsBefore = requestsOf(rig.proxy.seen, "tools/list").length;
        const changesBefore = countListChanged([listen!]);

        await rig.setList(["alpha", "bravo"]);

        // The notification goes out on the listen stream, and the CLI lists again.
        expect(
          await waitWithin(STEP_MS, () => countListChanged([listen!]) > changesBefore),
          "list_changed on subscriptions/listen",
        ).toBe(true);
        await waitForTools(running, ALL_TOOLS);
        expect(requestsOf(rig.proxy.seen, "tools/list").length).toBeGreaterThan(listsBefore);

        // The call goes through the new era too.
        const called = await running.runToolCall();
        expect(called.isError).toBe(false);
        expect(called.text).toContain("hello");
        expect(requestsOf(rig.proxy.seen, "tools/call").map(describeRequest)).toEqual([
          "POST tools/call 2026-07-28 no-session 200",
        ]);
      });
    });
  }, 120_000);

  it("works on the older path when server/discover is refused, lists again on list_changed from the GET stream, and opens a new MCP session after a 404", async () => {
    await withGateway({ answerDiscoverLikeOlderServer: true }, async (rig) => {
      await withClaude(rig, async (running) => {
        await waitForTools(running, ALPHA_TOOLS);

        // initialize, then the initialized notification and the GET stream, each carrying the MCP session id.
        const [discover, initialize] = rig.proxy.seen;
        expect(describeRequest(discover!)).toBe("POST server/discover 2026-07-28 no-session 400");
        expect(describeRequest(initialize!)).toBe("POST initialize no-revision no-session 200");
        const firstSession = initialize!.answeredSessionId!;
        expect(firstSession).not.toBeNull();
        const [get] = requestsOf(rig.proxy.seen, "GET");
        expect(describeRequest(get!)).toBe("GET - 2025-11-25 session 200");
        expect(get!.sessionId).toBe(firstSession);
        for (const method of ["notifications/initialized", "tools/list"]) {
          const [one] = requestsOf(rig.proxy.seen, method);
          expect(describeRequest(one!), method).toContain("2025-11-25 session");
          expect(one!.sessionId, method).toBe(firstSession);
        }

        const changesBefore = countListChanged([get!]);
        await rig.setList(["alpha", "bravo"]);
        expect(
          await waitWithin(STEP_MS, () => countListChanged([get!]) > changesBefore),
          "list_changed on the GET stream",
        ).toBe(true);
        await waitForTools(running, ALL_TOOLS);

        // The controller forgets the MCP session, as a restart does. The CLI is not told.
        const gone = await fetch(`${rig.gatewayUrl}/mcp`, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${rig.sessionToken}`,
            "mcp-session-id": firstSession,
            "mcp-protocol-version": "2025-11-25",
          },
        });
        expect(gone.status).toBe(204);

        // Its own next request is a tool call, which names the forgotten session.
        const afterRestart = rig.proxy.seen.length;
        const result = await running.runToolCall();
        expect(result.isError).toBe(false);
        expect(result.text).toContain("hello");
        const [refused] = requestsOf(rig.proxy.seen.slice(afterRestart), "tools/call");
        expect(describeRequest(refused!)).toBe("POST tools/call 2025-11-25 session 404");
        expect(refused!.sessionId).toBe(firstSession);

        // The CLI handshakes again and sends the call once more on a session of its own making.
        const newSessions = requestsOf(rig.proxy.seen.slice(afterRestart), "initialize").map(
          (one) => one.answeredSessionId,
        );
        expect(newSessions.length).toBeGreaterThan(0);
        expect(newSessions).not.toContain(firstSession);
        const retried = requestsOf(rig.proxy.seen.slice(afterRestart), "tools/call").at(-1)!;
        expect(retried.status).toBe(200);
        expect(newSessions).toContain(retried.sessionId);

        // The new MCP sessions have streams of their own, and a change reaches the CLI on them.
        // The CLI may still be handshaking, so wait until it has been quiet for a moment.
        await waitUntilQuiet(rig.proxy);
        const newStreams = requestsOf(rig.proxy.seen.slice(afterRestart), "GET").filter(
          (one) => one.status === 200,
        );
        expect(newStreams.length).toBeGreaterThan(0);
        expect(newStreams.map((one) => one.sessionId)).not.toContain(firstSession);
        const changesOnNew = countListChanged(newStreams);
        await rig.setList(["alpha"]);
        expect(
          await waitWithin(STEP_MS, () => countListChanged(newStreams) > changesOnNew),
          "list_changed on the new MCP sessions' streams",
        ).toBe(true);
        await waitForTools(running, ALPHA_TOOLS);
      });
    });
  }, 120_000);
});

describe.skipIf(claude === undefined)("the real Claude Code on servers added by address", () => {
  const TOKEN = "tok-claude-code-0123456789";
  let open: FakeUpstream;
  let tokened: FakeUpstream;

  beforeAll(async () => {
    open = await startFakeUpstream();
    tokened = await startFakeUpstream();
    // The fake that holds the token refuses every request that does not carry it.
    tokened.authorize = (authorization) => authorization === `Bearer ${TOKEN}`;
  });

  afterAll(async () => {
    await open.stop();
    await tokened.stop();
  });

  it("calls a tool of a server with no sign-in and of one with a token, and the token is in neither the CLI's stdout messages nor its config folder", async () => {
    await withFleet(async (arranged) => {
      const controller = {
        harness: arranged.harness,
        base: arranged.harness.base,
        token: arranged.token,
      };
      const ids: Array<string> = [];
      for (const [name, fake, token] of [
        ["open", open, undefined],
        ["tokened", tokened, TOKEN],
      ] as const) {
        const created = await post(
          controller.base,
          "/api/v1/mcp-servers",
          {
            source: { kind: "url", url: fake.url, name, ...(token === undefined ? {} : { token }) },
          },
          controller.token,
        );
        expect(created.status, await created.clone().text()).toBe(200);
        const { id } = (await created.json()) as { readonly id: string };
        await eventually(
          () => readServer(controller, id),
          (record) => record.status === "ready",
        );
        ids.push(id);
      }

      await withThreadOnGateway(
        arranged,
        {
          serverIds: ids,
          tools: ["mcp__tools__open__echo", "mcp__tools__tokened__echo"],
          answerDiscoverLikeOlderServer: false,
        },
        async (rig) => {
          await withClaude(rig, async (running) => {
            await eventually(
              () => running.readStatus(),
              (reported) =>
                reported.status === "connected" &&
                reported.tools.join() === "open__echo,tokened__echo",
            );

            const results = await running.runToolCalls(2);

            expect(results.map((result) => result.isError)).toEqual([false, false]);
            expect(results.map((result) => result.text)).toEqual([
              expect.stringContaining("hello"),
              expect.stringContaining("hello"),
            ]);
            for (const fake of [open, tokened]) {
              expect(fake.requests.filter((request) => request.method === "tools/call")).toEqual([
                expect.objectContaining({ tool: "echo", status: 200 }),
              ]);
            }
            // The fake that holds the token let in only requests with the bearer. The other saw none.
            expect(new Set(tokened.requests.map((request) => request.authorization))).toEqual(
              new Set([`Bearer ${TOKEN}`]),
            );
            expect(new Set(open.requests.map((request) => request.authorization))).toEqual(
              new Set([null]),
            );

            // The CLI records which tools it used in its config folder, a moment after the call.
            // Waiting for that record means the search below has something to find in the files.
            expect(
              await waitWithin(STEP_MS, () =>
                running.readTraces().files.includes("mcp__tools__tokened__echo"),
              ),
              "the CLI's record of its tool use",
            ).toBe(true);
            // Only these two surfaces are searched for the token: the messages
            // the CLI wrote to its stdout, and the files under its config folders.
            const traces = running.readTraces();
            expect(traces.output).not.toContain(TOKEN);
            expect(traces.files).not.toContain(TOKEN);
          });
        },
      );
    });
  }, 120_000);
});
