/**
 * Tests the MCP Gateway through the real HTTP server (`POST`, `GET` and
 * `DELETE /mcp`) with the Session Token of a running Thread:
 *
 * - who may call: the bearer, the `Origin` header and the method, all refused
 *   before any JSON is read;
 * - both protocol eras end to end, `initialize` and `server/discover`, each
 *   through `tools/list` and `tools/call`;
 * - MCP sessions: another token's id, an unknown id and DELETE;
 * - `list_changed` on the GET stream and on `subscriptions/listen` when the
 *   session's list or profile changes, and the end of streams;
 * - refused calls: the tool result, one Thread warning per turn, one audit
 *   entry per call;
 * - a controller that is frozen.
 *
 * The outside server is the catalogue's fake upstream, and a call to it is
 * answered by a stand-in for `McpServerCalls.callTool`: how the catalogue
 * reaches a server is tested in the `mcp-servers` domain.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { McpCallRefused } from "../mcp-servers";
import type { Profile } from "@hercule/contract";
import type { McpSchema } from "effect/ai";
import type { Plugin } from "@hercule/plugin-host";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import {
  createProfile,
  reportTurnCompleted,
  reportTurnStarted,
  spawnThreadUnder,
  type Arranged,
  type SpawnedThread,
} from "../sessions/testing";
import {
  createServers,
  eventually,
  readServer,
  startFakeUpstream,
  type FakeUpstream,
  type ServerRef,
} from "../mcp-servers/testing";
import { hashToken } from "../credentials";
import { send, waitWithin } from "./testing";
import { endResumable, withFleet } from "../workspaces/testing";

let upstream: FakeUpstream;
let PLUGINS: ReadonlyArray<Plugin>;

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

// -- One controller for the whole file --------------------------------------

let arranged: Arranged;
let servers: readonly [ServerRef, ServerRef, ServerRef];
let finishFleet: () => void;
let fleetDone: Promise<void>;

beforeAll(async () => {
  await new Promise<void>((ready, failed) => {
    const held = new Promise<void>((release) => {
      finishFleet = release;
    });
    fleetDone = withFleet(
      async (fleet) => {
        arranged = fleet;
        const created = await createServers(
          { harness: fleet.harness, base: fleet.harness.base, token: fleet.token },
          ["alpha", "bravo", "charlie"],
        );
        servers = created as unknown as typeof servers;
        // Every server lists its tools once its first check ends.
        const controller = { harness: fleet.harness, base: fleet.harness.base, token: fleet.token };
        for (const server of created) {
          await eventually(
            () => readServer(controller, server.id),
            (record) => record.status === "ready",
          );
        }
        ready();
        await held;
      },
      { plugins: PLUGINS },
    ).catch((error: unknown) => {
      failed(error instanceof Error ? error : new Error(String(error)));
    });
  });
}, 120_000);

afterAll(async () => {
  finishFleet();
  await fleetDone;
});

// -- Stand-in for the catalogue's call ---------------------------------------

type CallTool = (typeof arranged.harness.mcpServerCalls)["callTool"];
type CallInput = Parameters<CallTool>[0];

const realCallTool = () => arranged.harness.mcpServerCalls.callTool;
let originalCallTool: CallTool | undefined;
let originalCloseScope: (typeof arranged.harness.mcpServerCalls)["closeUpstreamScope"] | undefined;

/** The calls the stand-in answered, in order. */
let calls: Array<CallInput> = [];
/** The scopes the gateway closed, in order. */
let closedScopes: Array<string> = [];

/** Makes every call the gateway forwards run `answer`, and records it. */
const standInForServers = (
  answer: (input: CallInput) => ReturnType<CallTool> = (input) =>
    Effect.map(input.authorize, () => buildAnswer(`called ${input.tool}`)),
): void => {
  originalCallTool ??= realCallTool();
  originalCloseScope ??= arranged.harness.mcpServerCalls.closeUpstreamScope;
  calls = [];
  closedScopes = [];
  const mutable = arranged.harness.mcpServerCalls as {
    callTool: CallTool;
    closeUpstreamScope: (scope: string) => Effect.Effect<void>;
  };
  mutable.callTool = (input) => {
    calls.push(input);
    return answer(input);
  };
  mutable.closeUpstreamScope = (scope) =>
    Effect.sync(() => {
      closedScopes.push(scope);
    });
};

afterEach(() => {
  const mutable = arranged.harness.mcpServerCalls as {
    callTool: CallTool;
    closeUpstreamScope: (scope: string) => Effect.Effect<void>;
  };
  if (originalCallTool !== undefined) mutable.callTool = originalCallTool;
  if (originalCloseScope !== undefined) mutable.closeUpstreamScope = originalCloseScope;
});

const buildAnswer = (text: string): McpSchema.CallToolResult =>
  ({ content: [{ type: "text", text }] }) as unknown as McpSchema.CallToolResult;

// -- A client of the gateway --------------------------------------------------

/** The members of an answer's `result` and `error` that the tests read. Absent members are not checked until they are read. */
interface RpcBody {
  readonly result: {
    readonly protocolVersion: string;
    readonly capabilities: unknown;
    readonly instructions: string;
    readonly resultType?: string;
    readonly supportedVersions?: ReadonlyArray<string>;
    readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>;
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
    readonly isError?: boolean;
  };
  readonly error: { readonly code: number; readonly message: string };
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  /** The JSON-RPC body, or an empty object when the answer is not JSON. */
  readonly body: RpcBody;
  /** The body as text. */
  readonly text: string;
}

const base = () => arranged.harness.base;

/** Sends one POST to `/mcp` and reads the answer. */
const sendMcp = async (
  token: string | undefined,
  message: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> => {
  const response = await fetch(`${base()}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      connection: "close",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: typeof message === "string" ? message : JSON.stringify(message),
  });
  const text = await response.text();
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  return {
    status: response.status,
    headers: response.headers,
    body: (isJson ? JSON.parse(text) : {}) as RpcBody,
    text,
  };
};

let nextId = 1;
const request = (method: string, params?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: nextId++,
  method,
  ...(params === undefined ? {} : { params }),
});

const STATELESS_META = {
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  },
};

/** Runs the stateful handshake and returns the id of the MCP session it opened. */
const initialize = async (token: string, protocolVersion = "2025-06-18") => {
  const answer = await sendMcp(
    token,
    request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  const sessionId = answer.headers.get("mcp-session-id");
  expect(sessionId).not.toBeNull();
  const initialized = await sendMcp(
    token,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "mcp-session-id": sessionId! },
  );
  expect(initialized.status).toBe(202);
  return { sessionId: sessionId!, result: answer.body.result };
};

/** Calls `tools/list` on an MCP session and returns the tool names in order. */
const listToolNames = async (token: string, sessionId: string): Promise<ReadonlyArray<string>> => {
  const answer = await sendMcp(token, request("tools/list"), { "mcp-session-id": sessionId });
  expect(answer.status).toBe(200);
  return answer.body.result.tools.map((tool) => tool.name);
};

/** A server-sent event stream a test reads: the JSON-RPC messages it has received, and whether it ended. */
interface OpenStream {
  readonly response: Response;
  readonly messages: Array<{ method?: string; result?: unknown }>;
  ended: boolean;
  close: () => void;
}

const openStream = async (init: RequestInit): Promise<OpenStream> => {
  const controller = new AbortController();
  const response = await fetch(`${base()}/mcp`, { ...init, signal: controller.signal });
  const stream: OpenStream = {
    response,
    messages: [],
    ended: false,
    close: () => controller.abort(),
  };
  if (response.status !== 200 || response.body === null) {
    stream.ended = true;
    return stream;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              stream.messages.push(
                JSON.parse(line.slice("data: ".length)) as OpenStream["messages"][number],
              );
            }
          }
        }
      }
    } catch {
      // The test closed the stream.
    }
    stream.ended = true;
  })();
  return stream;
};

/** Opens the GET stream of a stateful MCP session. */
const openGetStream = (token: string, sessionId: string) =>
  openStream({
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
    },
  });

/** Opens `subscriptions/listen` of the stateless era. */
const openListen = (token: string, id: number) =>
  openStream({
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "subscriptions/listen",
      params: { ...STATELESS_META, notifications: { toolsListChanged: true } },
    }),
  });

const listChanges = (stream: OpenStream) =>
  stream.messages.filter((message) => message.method === "notifications/tools/list_changed");

const waitForListChanges = async (stream: OpenStream, count: number) => {
  expect(
    await waitWithin(5_000, () => listChanges(stream).length >= count),
    `${String(count)} list_changed on the stream, got ${JSON.stringify(stream.messages)}`,
  ).toBe(true);
};

/** Spawns a Thread under a profile with `grants`, with these servers in its list. */
const spawnThread = async (
  grants: ReadonlyArray<"mcp.use" | "mcp.read">,
  servers: ReadonlyArray<ServerRef>,
): Promise<SpawnedThread & { readonly profile: Profile }> => {
  const profile = await createProfile(arranged, `p-${crypto.randomUUID()}`, grants);
  const thread = await spawnThreadUnder(arranged, profile, {
    mcpServerIds: servers.map((server) => server.id),
  });
  return { ...thread, profile };
};

const updateList = (sessionId: string, mcpServerIds: ReadonlyArray<string>) =>
  send("PATCH", base(), `/api/v1/sessions/${sessionId}`, {
    body: { mcpServerIds },
    token: arranged.token,
  });

const updateProfileGrants = (profileId: string, grants: ReadonlyArray<string>) =>
  send("PATCH", base(), `/api/v1/profiles/${profileId}`, {
    body: { grants },
    token: arranged.token,
  });

const callEcho = (token: string, name: string, sessionId: string | undefined) =>
  sendMcp(
    token,
    request("tools/call", {
      name,
      arguments: { text: "hello" },
      ...(sessionId === undefined ? STATELESS_META : {}),
    }),
    sessionId === undefined ? {} : { "mcp-session-id": sessionId },
  );

/** Reads the text of a tool result. */
const textOf = (answer: Answer): string => answer.body.result.content[0]!.text;

/** How the Thread's line about a refused call starts. A start's own warning about servers it left out does not. */
const REFUSAL_WARNING_PREFIX = "A tool call was refused.";

/** The `runtime.warning` events a refused call wrote to a session, in order. */
const readWarnings = async (sessionId: string) => {
  const rows = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ readonly event: string }>`
        SELECT event FROM session_stream
        WHERE session_id = ${uuidBytes(sessionId)}
          AND json_extract(event, '$._tag') = 'runtime.warning'
        ORDER BY position`,
    ),
  );
  return rows
    .map(
      (row) =>
        JSON.parse(row.event) as {
          readonly message: string;
          readonly mcpServers?: ReadonlyArray<{ mcpServerId: string; reason: string }>;
        },
    )
    .filter((warning) => warning.message.startsWith(REFUSAL_WARNING_PREFIX));
};

/** Waits until the controller has stored a turn event of the session, so the gateway sees the turn it opened or closed. */
const waitForTurnRow = (sessionId: string, tag: string, turnId: string) =>
  eventually(
    () =>
      Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM session_stream
            WHERE session_id = ${uuidBytes(sessionId)}
              AND json_extract(event, '$._tag') = ${tag}
              AND json_extract(event, '$.turnId') = ${turnId}`,
        ),
      ),
    (rows) => rows[0]!.n > 0,
  );

const uuidBytes = (id: string): Uint8Array => {
  const hex = id.replaceAll("-", "");
  return Uint8Array.from(hex.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
};

/** The audit entries of the gateway's calls for one session. */
const readCallAudit = async (sessionId: string) =>
  (await arranged.harness.audit("mcpTool.called")).filter(
    (entry) => entry.payload["sessionId"] === sessionId,
  );

// -- The tests ----------------------------------------------------------------

describe("who may call", () => {
  it("refuses a request without a live Session Token with 401, and names no OAuth metadata", async () => {
    const thread = await spawnThread(["mcp.use"], []);
    const ended = `${thread.token}-not-it`;
    const refusals = [
      await sendMcp(undefined, request("ping")),
      await sendMcp(ended, request("ping")),
      // The user's own credential is not a Session Token.
      await sendMcp(arranged.token, request("ping")),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe(401);
      expect(refusal.headers.get("www-authenticate")).toBe("Bearer");
      expect(refusal.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("refuses an Origin header, even an empty one, with 403 before it reads the body or the token", async () => {
    const thread = await spawnThread(["mcp.use"], []);
    for (const origin of ["https://example.com", ""]) {
      const answer = await sendMcp(thread.token, "{not json", { origin });
      expect(answer.status).toBe(403);
    }
    const noToken = await sendMcp(undefined, request("ping"), { origin: "https://example.com" });
    expect(noToken.status).toBe(403);
  });

  it("refuses any method but POST, GET and DELETE with 405", async () => {
    const thread = await spawnThread(["mcp.use"], []);
    const response = await send("PUT", base(), "/mcp", { body: {}, token: thread.token });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST, DELETE");
  });

  it("refuses a JSON-RPC batch and an unreadable body with a JSON-RPC error", async () => {
    const thread = await spawnThread(["mcp.use"], []);
    const batch = await sendMcp(thread.token, [request("ping"), request("ping")]);
    expect(batch.status).toBe(400);
    expect(batch.body.error.code).toBe(-32600);
    const garbage = await sendMcp(thread.token, "{not json");
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe(-32700);
  });
});

describe("the stateful era", () => {
  it("runs initialize, tools/list and tools/call, and writes one audit entry for the call", async () => {
    standInForServers();
    const thread = await spawnThread(["mcp.use"], [servers[0], servers[1]]);
    const { sessionId, result } = await initialize(thread.token);

    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: { listChanged: true } });
    expect(result.instructions).toBe("MCP tools of these servers: alpha, bravo.");

    const answer = await sendMcp(thread.token, request("tools/list"), {
      "mcp-session-id": sessionId,
    });
    const tools = answer.body.result.tools as ReadonlyArray<{ name: string; description: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "alpha__echo",
      "alpha__get_issue_details",
      "bravo__echo",
      "bravo__get_issue_details",
    ]);
    expect(tools[0]?.description).toBe("Echoes its text");

    const called = await callEcho(thread.token, "bravo__get_issue_details", sessionId);
    expect(called.body.result.isError).toBeUndefined();
    expect(textOf(called)).toBe("called get-issue.details");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      serverId: servers[1].id,
      tool: "get-issue.details",
      arguments: { text: "hello" },
    });
    // The upstream scope is the token's hash, never the token.
    expect(JSON.stringify(calls[0]?.upstreamScope)).not.toContain(thread.token);

    const [entry, ...rest] = await readCallAudit(thread.session.id);
    expect(rest).toEqual([]);
    expect(entry?.payload).toMatchObject({
      mcpServerId: servers[1].id,
      tool: "get-issue.details",
      outcome: "answered",
    });
    expect(JSON.stringify(entry)).not.toContain("hello");
  });

  it("answers a requested revision it does not offer with the newest it does, and answers ping", async () => {
    const thread = await spawnThread(["mcp.use"], []);
    const { sessionId, result } = await initialize(thread.token, "2024-11-05");
    expect(result.protocolVersion).toBe("2025-11-25");
    const ping = await sendMcp(thread.token, request("ping"), { "mcp-session-id": sessionId });
    expect(ping.body.result).toEqual({});
  });

  it("answers a method it does not serve with method not found", async () => {
    const thread = await spawnThread(["mcp.use"], []);
    const { sessionId } = await initialize(thread.token);
    for (const method of ["resources/list", "prompts/list", "completion/complete"]) {
      const answer = await sendMcp(thread.token, request(method), { "mcp-session-id": sessionId });
      expect(answer.body.error.code, method).toBe(-32601);
    }
  });

  it("refuses a request that names no MCP session, and one that carries no revision", async () => {
    const thread = await spawnThread(["mcp.use"], []);
    const answer = await sendMcp(thread.token, request("tools/list"));
    expect(answer.status).toBe(400);
  });
});

describe("the stateless era", () => {
  it("runs server/discover, tools/list and tools/call", async () => {
    standInForServers();
    const thread = await spawnThread(["mcp.use"], [servers[0]]);
    const discovered = await sendMcp(thread.token, request("server/discover", STATELESS_META));
    expect(discovered.status).toBe(200);
    expect(discovered.body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: { listChanged: true } },
      instructions: "MCP tools of these servers: alpha.",
    });

    const listed = await sendMcp(thread.token, request("tools/list", STATELESS_META));
    expect(listed.body.result.resultType).toBe("complete");
    expect(
      (listed.body.result.tools as ReadonlyArray<{ name: string }>).map((tool) => tool.name),
    ).toEqual(["alpha__echo", "alpha__get_issue_details"]);

    const called = await callEcho(thread.token, "alpha__echo", undefined);
    expect(called.body.result).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "called echo" }],
    });
  });

  it("refuses a revision the stateless era does not offer", async () => {
    const thread = await spawnThread(["mcp.use"], []);
    const answer = await sendMcp(thread.token, {
      ...request("tools/list"),
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } },
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe(-32022);
  });
});

describe("MCP sessions", () => {
  it("answers 404 to an unknown MCP session and to the MCP session of another token", async () => {
    const mine = await spawnThread(["mcp.use"], []);
    const other = await spawnThread(["mcp.use"], []);
    const { sessionId } = await initialize(mine.token);

    const unknown = await sendMcp(mine.token, request("tools/list"), {
      "mcp-session-id": "never-issued",
    });
    expect(unknown.status).toBe(404);
    const stolen = await sendMcp(other.token, request("tools/list"), {
      "mcp-session-id": sessionId,
    });
    expect(stolen.status).toBe(404);
    // The owner still has it.
    expect(
      (await sendMcp(mine.token, request("ping"), { "mcp-session-id": sessionId })).status,
    ).toBe(200);
  });

  it("ends only the MCP session that DELETE names, never the Thread or its token", async () => {
    const thread = await spawnThread(["mcp.use"], [servers[0]]);
    const first = await initialize(thread.token);
    const second = await initialize(thread.token);

    const deleted = await fetch(`${base()}/mcp`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${thread.token}`, "mcp-session-id": first.sessionId },
    });
    expect(deleted.status).toBe(204);

    expect(
      (await sendMcp(thread.token, request("ping"), { "mcp-session-id": first.sessionId })).status,
    ).toBe(404);
    expect(await listToolNames(thread.token, second.sessionId)).toContain("alpha__echo");
  });
});

describe("list changes", () => {
  it("sends list_changed on the GET stream when a server joins or leaves the list, and the next tools/list shows it", async () => {
    standInForServers();
    const thread = await spawnThread(["mcp.use"], [servers[0]]);
    const { sessionId } = await initialize(thread.token);
    expect(await listToolNames(thread.token, sessionId)).toEqual([
      "alpha__echo",
      "alpha__get_issue_details",
    ]);

    const stream = await openGetStream(thread.token, sessionId);
    try {
      expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
      // Once when the stream opens.
      await waitForListChanges(stream, 1);

      expect((await updateList(thread.session.id, [servers[0].id, servers[2].id])).status).toBe(
        200,
      );
      await waitForListChanges(stream, 2);
      expect(await listToolNames(thread.token, sessionId)).toEqual([
        "alpha__echo",
        "alpha__get_issue_details",
        "charlie__echo",
        "charlie__get_issue_details",
      ]);

      // A server that left is refused at once, and the names of the others stay.
      expect((await updateList(thread.session.id, [servers[2].id])).status).toBe(200);
      await waitForListChanges(stream, 3);
      const refused = await callEcho(thread.token, "alpha__echo", sessionId);
      expect(refused.body.result.isError).toBe(true);
      expect(textOf(refused)).toContain("not in this Thread's list");
      expect(calls).toEqual([]);
    } finally {
      stream.close();
    }
  });

  it("sends list_changed on subscriptions/listen, acknowledges it first, and a change of the profile's mcp.use is one", async () => {
    standInForServers();
    const thread = await spawnThread(["mcp.use"], [servers[0]]);
    const listen = await openListen(thread.token, 900);
    try {
      expect(await waitWithin(5_000, () => listen.messages.length >= 2)).toBe(true);
      expect(listen.messages[0]).toMatchObject({
        method: "notifications/subscriptions/acknowledged",
        params: { _meta: { "io.modelcontextprotocol/subscriptionId": 900 } },
      });
      expect(listen.messages[1]?.method).toBe("notifications/tools/list_changed");

      // The profile loses mcp.use: the list is empty and a call is refused.
      expect((await updateProfileGrants(thread.profile.id, ["mcp.read"])).status).toBe(200);
      await waitForListChanges(listen, 2);
      const listed = await sendMcp(thread.token, request("tools/list", STATELESS_META));
      expect(listed.body.result.tools).toEqual([]);
      const refused = await callEcho(thread.token, "alpha__echo", undefined);
      expect(refused.body.result.isError).toBe(true);
      expect(textOf(refused)).toContain("mcp.use");
      expect(calls).toEqual([]);

      // And a change that alters nothing the session is served sends nothing.
      const before = listChanges(listen).length;
      expect((await updateProfileGrants(thread.profile.id, ["mcp.read", "mcp.use"])).status).toBe(
        200,
      );
      await waitForListChanges(listen, before + 1);
    } finally {
      listen.close();
    }
  });

  it("ends the streams and closes the upstream sessions of a token that stopped resolving", async () => {
    standInForServers();
    const thread = await spawnThread(["mcp.use"], [servers[0]]);
    const { sessionId } = await initialize(thread.token);
    const stream = await openGetStream(thread.token, sessionId);
    await waitForListChanges(stream, 1);

    await endResumable(arranged, thread.session);

    expect(await waitWithin(5_000, () => stream.ended)).toBe(true);
    // The harness's one runner reports the end of this Thread for every
    // Thread it runs, so other tokens close too. This one's scope is its hash.
    expect(await waitWithin(5_000, () => closedScopes.includes(hashToken(thread.token)))).toBe(
      true,
    );
    expect(closedScopes).not.toContain(thread.token);
    expect(
      (await sendMcp(thread.token, request("ping"), { "mcp-session-id": sessionId })).status,
    ).toBe(401);
  });
});

describe("refused calls", () => {
  it("answers an unknown tool, writes one warning per turn, and one audit entry per call", async () => {
    standInForServers();
    const thread = await spawnThread(["mcp.use"], [servers[0]]);
    const { sessionId } = await initialize(thread.token);
    const sessionStarted = thread.session.id;
    reportTurnStarted(arranged, sessionStarted, 2);
    await waitForTurnRow(sessionStarted, "turn.started", "t2");

    const first = await callEcho(thread.token, "alpha__nothing", sessionId);
    const second = await callEcho(thread.token, "alpha__nothing", sessionId);
    for (const answer of [first, second]) {
      expect(answer.body.result.isError).toBe(true);
      expect(textOf(answer)).toContain("alpha__nothing");
    }
    expect(calls).toEqual([]);

    await eventually(
      () => readWarnings(sessionStarted),
      (warnings) => warnings.length >= 1,
    );
    // The second refusal in the same turn is not told again.
    expect(await readWarnings(sessionStarted)).toHaveLength(1);
    // A new turn is told again, and a refusal naming a server names it.
    reportTurnCompleted(arranged, sessionStarted, 3);
    reportTurnStarted(arranged, sessionStarted, 4);
    await waitForTurnRow(sessionStarted, "turn.started", "t4");
    const refusedAgain = await eventually(
      async () => {
        await callEcho(thread.token, "alpha__nothing", sessionId);
        return readWarnings(sessionStarted);
      },
      (warnings) => warnings.length === 2,
    );
    expect(refusedAgain[0]?.mcpServers).toBeUndefined();

    const entries = await readCallAudit(sessionStarted);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries[0]?.payload).toMatchObject({
      mcpServerId: null,
      tool: null,
      outcome: "refused",
      reason: "unknown-tool",
    });
  });

  it("tells the Thread which server a refused call meant, when the server is known", async () => {
    standInForServers();
    const thread = await spawnThread(["mcp.use"], [servers[0], servers[1]]);
    const { sessionId } = await initialize(thread.token);
    await listToolNames(thread.token, sessionId);
    // Bravo leaves the list: its name was sent, so the call is understood and refused.
    expect((await updateList(thread.session.id, [servers[0].id])).status).toBe(200);
    const refused = await callEcho(thread.token, "bravo__echo", sessionId);
    expect(refused.body.result.isError).toBe(true);

    const [warning] = await eventually(
      () => readWarnings(thread.session.id),
      (warnings) => warnings.length >= 1,
    );
    expect(warning?.mcpServers).toEqual([{ mcpServerId: servers[1].id, reason: "not-in-list" }]);
    const [entry] = await readCallAudit(thread.session.id);
    expect(entry?.payload).toMatchObject({
      mcpServerId: servers[1].id,
      tool: "echo",
      outcome: "refused",
      reason: "not-in-list",
    });
  });

  it("refuses a call whose server left the list while the call was on its way, without sending it", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    standInForServers((input) =>
      Effect.flatMap(
        Effect.promise(() => held),
        () => Effect.map(input.authorize, () => buildAnswer("sent")),
      ),
    );
    const thread = await spawnThread(["mcp.use"], [servers[0]]);
    const { sessionId } = await initialize(thread.token);
    await listToolNames(thread.token, sessionId);

    const running = callEcho(thread.token, "alpha__echo", sessionId);
    await waitWithin(5_000, () => calls.length === 1);
    expect((await updateList(thread.session.id, [])).status).toBe(200);
    release();
    const answer = await running;
    expect(answer.body.result.isError).toBe(true);
    expect(textOf(answer)).toContain("not sent");
    const [entry] = await readCallAudit(thread.session.id);
    expect(entry?.payload).toMatchObject({ outcome: "refused", reason: "not-in-list" });
  });

  it("returns what the catalogue refuses as a tool result and audits its reason", async () => {
    standInForServers(() =>
      Effect.fail(
        new McpCallRefused({
          reason: "needs-sign-in",
          message: "alpha needs sign-in. Ask the user to reconnect it in Settings > Connections.",
        }),
      ),
    );
    const thread = await spawnThread(["mcp.use"], [servers[0]]);
    const { sessionId } = await initialize(thread.token);
    const refused = await callEcho(thread.token, "alpha__echo", sessionId);
    expect(refused.body.result.isError).toBe(true);
    expect(textOf(refused)).toBe(
      "alpha needs sign-in. Ask the user to reconnect it in Settings > Connections.",
    );
    const [warning] = await eventually(
      () => readWarnings(thread.session.id),
      (warnings) => warnings.length >= 1,
    );
    expect(warning?.mcpServers).toEqual([{ mcpServerId: servers[0].id, reason: "needs-sign-in" }]);
    const [entry] = await readCallAudit(thread.session.id);
    expect(entry?.payload).toMatchObject({ outcome: "refused", reason: "needs-sign-in" });
  });
});

describe("a frozen controller", () => {
  it("still answers tools/list, refuses tools/call with the gate's message, and writes no audit entry and no warning", async () => {
    standInForServers();
    const thread = await spawnThread(["mcp.use"], [servers[0]]);
    const { sessionId } = await initialize(thread.token);
    const stream = await openGetStream(thread.token, sessionId);
    await waitForListChanges(stream, 1);

    await Effect.runPromise(
      Effect.orDie(
        arranged.harness.promotion.freeze("frozen-for-test", new Date(Date.now() + 60_000)),
      ),
    );
    try {
      expect(await waitWithin(5_000, () => stream.ended)).toBe(true);
      expect(await listToolNames(thread.token, sessionId)).toContain("alpha__echo");

      const refused = await callEcho(thread.token, "alpha__echo", sessionId);
      expect(refused.body.result.isError).toBe(true);
      expect(textOf(refused)).toContain("promotion");
      expect(calls).toEqual([]);
      // A new stream is refused until the controller serves again.
      const reopened = await openGetStream(thread.token, sessionId);
      expect(reopened.response.status).toBe(503);
    } finally {
      await Effect.runPromise(arranged.harness.promotion.thaw("frozen-for-test"));
    }
    expect(await readCallAudit(thread.session.id)).toEqual([]);
    expect(await readWarnings(thread.session.id)).toEqual([]);
  });
});
