/**
 * A fake MCP server for tests of everything that talks to an outside MCP
 * server: the checks now, the gateway's calls later. It is Effect's own
 * `McpServer` behind `Bun.serve` on a free port of the loopback address, so it
 * speaks the protocol for real, and a test decides what it does:
 *
 * - which MCP revisions it speaks and which tools it lists;
 * - whether a request is authorized, by its `Authorization` header, which is
 *   how a test scripts a 401;
 * - whether it redirects instead of answering;
 * - whether it holds every answer until the test lets go;
 * - what a call of each tool answers: its arguments echoed back, a tool's own
 *   error, a JSON-RPC error, or an answer over the size cap;
 * - what to answer to a request instead of the protocol, for a scripted 401, a
 *   404 for an expired MCP session or a 403.
 *
 * It decides what to answer when a request arrives, and holds the answer
 * after that, so a test can change what the fake does while an answer is on
 * its way. It records every request's JSON-RPC method, tool, address,
 * `Authorization`, `Mcp-Session-Id` and `Mcp-Protocol-Version` headers, so a
 * test can check what the controller sent.
 *
 * The helpers below the fake are the ones every test of an MCP Server's
 * checks and operations shares: reading the stored row, creating a server and
 * waiting for a result.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { expect } from "vitest";
import type {
  ConnectionStatus,
  McpServer as McpServerRecord,
  McpServerStatus,
  Project,
  Session,
} from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { connectionRepository, OAUTH_TOKENS } from "../connections";
import { computeChallenge } from "../oauth";
import { buildJsonResponse, createDeviceProvider } from "../connections/testing";
import { nowIso, withTransaction } from "../db";
import { get, post, send, type ServerHarness } from "../http/testing";
import { NO_INTAKE_OVERRIDES } from "../intake-settings";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import {
  WAIT_DEADLINE_MS,
  findProviderAccountId,
  readProfileNamed,
  type Arranged,
} from "../sessions/testing";
import { withFleet } from "../workspaces/testing";
import { createConnection, withSetUpController, type SetUpController } from "../workflows/testing";
import type { McpServerView, PluginState } from "./catalogue";
import type { McpToolCall } from "./calls";
import { mcpServerRepository, type McpServerUrlSource } from "./repository";

/**
 * One tool the fake lists. A call answers as `answer` says:
 *
 * - `echo` (the default): a text block holding the call's arguments as JSON;
 * - `tool-error`: a result with `isError: true`;
 * - `rpc-error`: a JSON-RPC error, the way a server refuses bad arguments;
 * - `too-large`: a text block over 4 MiB.
 */
export interface FakeTool {
  readonly name: string;
  readonly description: string;
  readonly answer?: "echo" | "tool-error" | "rpc-error" | "too-large";
}

/** What the fake answers a call with, by `FakeTool.answer`. */
const answerCall = (fake: FakeTool, payload: unknown) => {
  switch (fake.answer ?? "echo") {
    case "echo":
      return Effect.succeed(
        new McpSchema.CallToolResult({
          content: [{ type: "text", text: JSON.stringify(payload) }],
        }),
      );
    case "tool-error":
      return Effect.succeed(
        new McpSchema.CallToolResult({
          content: [{ type: "text", text: "the tool failed on its own" }],
          isError: true,
        }),
      );
    case "rpc-error":
      return Effect.fail(new McpSchema.InvalidParams({ message: "the arguments do not fit" }));
    case "too-large":
      return Effect.succeed(
        new McpSchema.CallToolResult({
          content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }],
        }),
      );
  }
};

/** What the fake can be asked to speak and list. */
export interface FakeUpstreamSettings {
  /** The MCP revisions the fake speaks. The default is the two newest. */
  readonly protocols: ReadonlyArray<McpProtocol.ProtocolAdapter>;
  readonly tools: ReadonlyArray<FakeTool>;
  /**
   * Makes the fake refuse requests the way a server built on the official
   * TypeScript SDK does, instead of the way Effect's own server does (see
   * `buildSdkRefusal`). Off by default.
   */
  readonly answersLikeOfficialSdk: boolean;
}

/** One request the fake received. `status` is `undefined` while the fake still holds the answer. */
export interface RecordedRequest {
  /** The JSON-RPC method, or `?` for a request that carries none, such as a DELETE. */
  readonly method: string;
  /** The tool a `tools/call` names, and `undefined` for every other request. */
  readonly tool: string | undefined;
  /** The `Mcp-Session-Id` header, which names the upstream MCP session of a legacy revision. */
  readonly sessionId: string | null;
  /** The path and query of the address the request went to. */
  readonly url: string;
  readonly authorization: string | null;
  readonly protocolVersion: string | null;
  status: number | undefined;
}

/** A request the fake lets in, as `FakeUpstream.intercept` sees it. */
export interface InterceptedRequest {
  readonly method: string;
  /** The JSON-RPC request's `id`, which a response must carry to answer it. */
  readonly id: unknown;
  /** The JSON-RPC request's `params`. */
  readonly params: Record<string, unknown> | undefined;
  /** The path and query of the address the request went to. */
  readonly url: string;
  readonly authorization: string | null;
  readonly sessionId: string | null;
}

export interface FakeUpstream {
  /** The address of the MCP endpoint. */
  readonly url: string;
  /** The scheme, host and port of the endpoint: the origin a plugin declares for it. */
  readonly origin: string;
  readonly requests: ReadonlyArray<RecordedRequest>;
  /**
   * Decides whether a request with this `Authorization` header and this
   * JSON-RPC method is let in. A request that is not gets HTTP 401. The
   * default lets every request in.
   */
  authorize: (authorization: string | null, method: string) => boolean;
  /** The `WWW-Authenticate` header of the HTTP 401 that `authorize` makes. The default is a bare `Bearer`. */
  challenge: string;
  /**
   * Looks at every request before anything else, and answers it by returning a
   * response, for the metadata a server publishes at a well-known address.
   * The request is not recorded. The default answers nothing.
   */
  answerFirst: (request: Request) => Response | undefined | Promise<Response | undefined>;
  /** When set, every request gets a 302 to this address instead of an answer. */
  redirectTo: string | undefined;
  /** When set, every request gets this HTTP status and an empty body instead of an answer. */
  refuseWithStatus: number | undefined;
  /**
   * Looks at every request the fake lets in, before the protocol answers it,
   * and may answer it instead by returning a response. The default answers
   * nothing.
   */
  intercept: (request: InterceptedRequest) => Response | undefined;
  /** Replaces the revisions it speaks and the tools it lists, for the requests that follow. */
  configure: (settings: Partial<FakeUpstreamSettings>) => Promise<void>;
  /**
   * Makes the fake hold the answer to every request, from now on, until the
   * returned function is called. With `method`, it holds only the requests
   * of that JSON-RPC method.
   */
  hold: (method?: string) => () => void;
  /** Resolves once the fake has received `count` requests in all. */
  waitForRequests: (count: number) => Promise<void>;
  stop: () => Promise<void>;
}

/** The versions the official TypeScript SDK's server accepts in `MCP-Protocol-Version`, newest first. */
const SDK_SUPPORTED_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

/**
 * Builds the refusal a server on the official TypeScript SDK (1.30.0,
 * `webStandardStreamableHttp.js`) gives a request before it reaches the
 * protocol, or `undefined` when the SDK lets the request through. Status,
 * code and message are the SDK's own:
 *
 * - a request other than `initialize` with no `Mcp-Session-Id` is HTTP 400,
 *   code -32000, "Bad Request: Server not initialized". `server/discover` is
 *   such a request, because the SDK knows only `initialize`;
 * - a request with a session and an `MCP-Protocol-Version` the server does
 *   not support is HTTP 400, code -32000, "Bad Request: Unsupported protocol
 *   version". The server supports the versions up to the newest it speaks.
 */
const buildSdkRefusal = (
  request: Request,
  method: string,
  settings: FakeUpstreamSettings,
): Response | undefined => {
  if (method === "initialize") return undefined;
  const refuse = (message: string) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  if (request.headers.get("mcp-session-id") === null) {
    return refuse("Bad Request: Server not initialized");
  }
  const newest = Math.min(
    ...settings.protocols.map((adapter) => SDK_SUPPORTED_VERSIONS.indexOf(adapter.protocolVersion)),
  );
  const supported = SDK_SUPPORTED_VERSIONS.slice(Math.max(newest, 0));
  const requested = request.headers.get("mcp-protocol-version");
  if (requested !== null && !supported.includes(requested)) {
    return refuse(
      `Bad Request: Unsupported protocol version: ${requested} (supported versions: ${supported.join(", ")})`,
    );
  }
  return undefined;
};

const buildHandler = (settings: FakeUpstreamSettings) => {
  const [first, ...rest] = settings.protocols;
  if (first === undefined) throw new Error("the fake MCP server needs at least one protocol");
  const toolLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      for (const fake of settings.tools) {
        yield* server.addTool({
          tool: new McpSchema.Tool({
            name: fake.name,
            description: fake.description,
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          }),
          annotations: Context.empty(),
          handle: (payload) => answerCall(fake, payload),
        });
      }
    }),
  );
  const app = toolLayer.pipe(
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "fake",
        version: "1",
        path: "/mcp",
        protocols: [first, ...rest],
        allowSessionTermination: true,
      }),
    ),
  );
  return HttpRouter.toWebHandler(app, { disableLogger: true });
};

/**
 * Starts a fake MCP server on a free port and returns it. The caller stops it
 * with `stop`. By default it speaks `2026-07-28` and `2025-11-25` and lists one
 * tool, `echo`.
 */
export const startFakeUpstream = (
  initial: Partial<FakeUpstreamSettings> = {},
): Promise<FakeUpstream> => {
  let settings: FakeUpstreamSettings = {
    protocols: initial.protocols ?? [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
    tools: initial.tools ?? [{ name: "echo", description: "Echoes its text" }],
    answersLikeOfficialSdk: initial.answersLikeOfficialSdk ?? false,
  };
  let built = buildHandler(settings);
  const requests: Array<RecordedRequest> = [];
  const arrivals: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  let held: { readonly released: Promise<void>; readonly method: string | undefined } | undefined;
  let stopped = false;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const early = await fake.answerFirst(request);
      if (early !== undefined) return early;
      let method = "?";
      let params: Record<string, unknown> | undefined;
      let id: unknown;
      try {
        const body = (await request.clone().json()) as {
          readonly id?: unknown;
          readonly method?: unknown;
          readonly params?: Record<string, unknown>;
        };
        if (typeof body.method === "string") method = body.method;
        params = body.params;
        id = body.id;
      } catch {
        // A request with no JSON body, such as a DELETE, has no method.
      }
      const address = new URL(request.url);
      const recorded: RecordedRequest = {
        method,
        tool: method === "tools/call" && typeof params?.name === "string" ? params.name : undefined,
        sessionId: request.headers.get("mcp-session-id"),
        url: `${address.pathname}${address.search}`,
        authorization: request.headers.get("authorization"),
        protocolVersion: request.headers.get("mcp-protocol-version"),
        status: undefined,
      };
      // The answer is decided on arrival and delivered once the hold ends, so
      // a test can change the rules while it is on its way.
      const response =
        fake.redirectTo !== undefined
          ? new Response(null, { status: 302, headers: { location: fake.redirectTo } })
          : fake.refuseWithStatus !== undefined
            ? new Response(null, { status: fake.refuseWithStatus })
            : !fake.authorize(recorded.authorization, method)
              ? new Response("unauthorized", {
                  status: 401,
                  headers: { "www-authenticate": fake.challenge },
                })
              : (fake.intercept({
                  method,
                  id,
                  params,
                  url: recorded.url,
                  authorization: recorded.authorization,
                  sessionId: recorded.sessionId,
                }) ??
                (settings.answersLikeOfficialSdk
                  ? buildSdkRefusal(request, method, settings)
                  : undefined) ??
                (await built.handler(request, Context.empty())));
      requests.push(recorded);
      for (const waiting of arrivals.filter((one) => requests.length >= one.count)) {
        waiting.resolve();
      }
      if (held !== undefined && (held.method === undefined || held.method === method)) {
        await held.released;
      }
      recorded.status = response.status;
      return response;
    },
  });

  const fake: FakeUpstream = {
    url: `http://127.0.0.1:${String(server.port)}/mcp`,
    origin: `http://127.0.0.1:${String(server.port)}`,
    requests,
    authorize: () => true,
    challenge: "Bearer",
    answerFirst: () => undefined,
    redirectTo: undefined,
    refuseWithStatus: undefined,
    intercept: () => undefined,
    configure: async (changes) => {
      settings = { ...settings, ...changes };
      const previous = built;
      built = buildHandler(settings);
      await previous.dispose();
    },
    hold: (method) => {
      let release: () => void = () => undefined;
      held = {
        released: new Promise<void>((resolve) => {
          release = resolve;
        }),
        method,
      };
      return () => {
        release();
        held = undefined;
      };
    },
    waitForRequests: (count) =>
      requests.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => arrivals.push({ count, resolve })),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.stop(true);
      await built.dispose();
    },
  };
  return Promise.resolve(fake);
};

/** The id of the plugin the tests of this domain give a Connection to. */
export const DESK_PLUGIN_ID = "acme";

/**
 * Stores a Connection with one secret and returns its id. No operation makes
 * one without a browser or a provider that answers, so the test writes the rows
 * a sign-in would.
 */
const insertConnection = (
  harness: ServerHarness,
  pluginId: string,
  type: string,
  secret: { readonly name: string; readonly value: string },
  accountId = "desk-1",
): Promise<string> =>
  Effect.runPromise(
    Effect.orDie(
      Effect.gen(function* () {
        const connections = yield* connectionRepository;
        const at = yield* nowIso;
        return yield* withTransaction(
          harness.sql,
          Effect.gen(function* () {
            const row = yield* connections.insert({
              pluginId,
              type,
              label: "work",
              displayName: "Desk",
              accountId,
              labels: [],
              config: {},
              at,
            });
            yield* harness.secrets.set(
              { kind: "connection", id: row.id },
              secret.name,
              Redacted.make(secret.value),
            );
            return row.id;
          }),
        );
      }).pipe(Effect.provideService(SqlClient.SqlClient, harness.sql)),
    ),
  );

/**
 * Stores a Connection of the OAuth flavor of `buildMcpServerPlugin` (the
 * plugin gets a `deviceProviderUrl`), with these tokens, and returns its id.
 */
export const insertOauthConnection = (
  harness: ServerHarness,
  tokens: { readonly accessToken: string; readonly refreshToken?: string },
  pluginId = DESK_PLUGIN_ID,
): Promise<string> =>
  insertConnection(harness, pluginId, `${pluginId}/desk`, {
    name: OAUTH_TOKENS,
    value: JSON.stringify({
      ...tokens,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    }),
  });

/**
 * Stores a Connection of any type with a pasted `token`, for the external
 * account `accountId`, and returns its id. For a Connection the API cannot
 * make: one of another account than the test plugin's, or one of a plugin
 * whose own validation would call the real vendor.
 */
export const insertPastedConnection = (
  harness: ServerHarness,
  type: string,
  token: string,
  accountId = "desk-1",
): Promise<string> =>
  insertConnection(
    harness,
    type.slice(0, type.indexOf("/")),
    type,
    { name: "token", value: token },
    accountId,
  );

/** The stored fields of an MCP Server a test looks at. */
export interface McpServerRow {
  readonly status: string;
  readonly status_detail: string | null;
  readonly status_cause: string | null;
  readonly tools: string;
  readonly checked_at: string | null;
  readonly protocol_version: string | null;
  readonly revision: number;
  readonly connection_generation: number;
  readonly failed_checks: number;
  readonly next_check_at: string | null;
  readonly updated_at: string;
  readonly notified_status: string | null;
  readonly sign_in_offered: string | null;
}

/** Runs a statement on the controller's database in its own transaction, for state no operation reaches. */
export const runSql = <A>(
  controller: Pick<SetUpController, "harness">,
  statement: Effect.Effect<A, unknown>,
) => Effect.runPromise(Effect.orDie(withTransaction(controller.harness.sql, statement)));

/**
 * Replaces the OAuth tokens a Connection holds, as another refresh would, and
 * sets them to expire `lifetimeMillis` from now: 8 hours unless said, or a
 * time already past, for a token that needs a refresh.
 */
export const storeOauthTokens = (
  controller: SetUpController,
  connectionId: string,
  tokens: { readonly accessToken: string; readonly refreshToken?: string },
  lifetimeMillis = 8 * 60 * 60 * 1000,
) =>
  runSql(
    controller,
    controller.harness.secrets.set(
      { kind: "connection", id: connectionId },
      OAUTH_TOKENS,
      Redacted.make(
        JSON.stringify({
          ...tokens,
          expiresAt: new Date(Date.now() + lifetimeMillis).toISOString(),
        }),
      ),
    ),
  );

/** Reads the stored row of the only server there is. */
export const readRow = async (controller: SetUpController): Promise<McpServerRow> => {
  const sql = controller.harness.sql;
  const rows = await runSql(
    controller,
    sql<McpServerRow>`SELECT status, status_detail, status_cause, tools, checked_at,
                             protocol_version, revision, connection_generation, failed_checks,
                             next_check_at, updated_at, notified_status, sign_in_offered
                      FROM mcp_servers`,
  );
  return rows[0]!;
};

/** Counts the Notifications of one kind: `core.mcp-server-failed` unless another kind is given. */
export const countNotifications = async (
  controller: SetUpController,
  kind = "core.mcp-server-failed",
): Promise<number> => {
  const sql = controller.harness.sql;
  const rows = await runSql(
    controller,
    sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM notifications WHERE kind = ${kind}`,
  );
  return rows[0]!.n;
};

/** Waits until `read` returns something `done` accepts, polling, and fails the test after ten seconds. */
export const eventually = async <A>(
  read: () => Promise<A>,
  done: (value: A) => boolean,
): Promise<A> => {
  const deadline = Date.now() + 10_000;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting, last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  return value;
};

/** Reads a response that must be a success, as a server record. */
export const readRecord = async (response: Response): Promise<McpServerRecord> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as McpServerRecord;
};

/** Reads a response that must be an error with `status`, and returns its error envelope. */
export const readRefusal = async (
  response: Response,
  status: number,
): Promise<{
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}> => {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return (JSON.parse(text) as { readonly error: Awaited<ReturnType<typeof readRefusal>> }).error;
};

/** Waits until the stored status of the only server is `status`, and returns its row. */
export const waitForStatus = (controller: SetUpController, status: string): Promise<McpServerRow> =>
  eventually(
    () => readRow(controller),
    (row) => row.status === status,
  );

/** The upstream scope `callAs` calls under. */
export const TEST_UPSTREAM_SCOPE = "scope-test";

/**
 * Calls a tool of a server through the controller's own `callTool`, as a
 * session would, and returns the result of the call. By default it calls
 * `echo` with `{ text: "hi" }` and admits the call.
 */
export const callAs = (
  controller: SetUpController,
  serverId: string,
  overrides: Partial<McpToolCall> = {},
) =>
  Effect.runPromise(
    Effect.result(
      controller.harness.mcpServerCalls.callTool({
        upstreamScope: TEST_UPSTREAM_SCOPE,
        serverId,
        tool: "echo",
        arguments: { text: "hi" },
        authorize: Effect.void,
        ...overrides,
      }),
    ),
  );

/** Sends `mcpServer.setToken` and returns the raw response. */
export const sendToken = (controller: SetUpController, id: string, token: string) =>
  post(controller.base, `/api/v1/mcp-servers/${id}/token`, { token }, controller.token);

/** Waits until the stored status is not `checking`, and returns the row. */
export const waitForResult = (controller: SetUpController): Promise<McpServerRow> =>
  eventually(
    () => readRow(controller),
    (row) => row.status !== "checking",
  );

/** What `requestCreate` sends: the Connection, and the contribution (`acme/desk` unless given). */
export interface CreateSource {
  readonly connectionId: string;
  readonly contributionId?: string;
  readonly name?: string;
}

/** Sends `mcpServer.create` and returns the raw response. */
export const requestCreate = (
  controller: SetUpController,
  source: Record<string, unknown>,
  token = controller.token,
) => post(controller.base, "/api/v1/mcp-servers", { source: { kind: "plugin", ...source } }, token);

/** Creates a server and returns it, failing the test when the create is refused. */
export const createServer = async (
  controller: SetUpController,
  source: CreateSource,
): Promise<McpServerRecord> => {
  const response = await requestCreate(controller, {
    contributionId: "acme/desk",
    ...source,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as McpServerRecord;
};

/** One server `createServers` made: its id and its name. */
export interface ServerRef {
  readonly id: string;
  readonly name: string;
}

/**
 * Creates one MCP Server for each name and returns them in that order. Each
 * server gets a Connection of its own external account, because a server is
 * unique per account, so two servers may share a name.
 */
export const createServers = async (
  controller: Pick<SetUpController, "harness" | "base" | "token">,
  names: ReadonlyArray<string>,
): Promise<ReadonlyArray<ServerRef>> => {
  const servers: Array<ServerRef> = [];
  for (const [index, name] of names.entries()) {
    const connectionId = await insertPastedConnection(
      controller.harness,
      "acme/desk",
      "t0ken",
      `desk-${String(index)}`,
    );
    const server = await createServer(controller, { connectionId, name });
    servers.push({ id: server.id, name });
  }
  return servers;
};

/** Creates a Project with the request body given, and returns the raw response. */
export const createProject = (
  controller: Pick<SetUpController, "base" | "token">,
  body: unknown,
  token = controller.token,
) => post(controller.base, "/api/v1/projects", body, token);

/** Reads a Project, failing the test when it cannot be read. */
export const readProject = async (
  controller: Pick<SetUpController, "base" | "token">,
  id: string,
): Promise<Project> => {
  const response = await get(controller.base, `/api/v1/projects/${id}`, controller.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Project;
};

/** A test that sets up a fleet and several Threads gets more than one wait deadline. */
export const TEST_TIMEOUT_MS = WAIT_DEADLINE_MS * 3 + 10_000;

/**
 * Runs `body` against a fleet with the given plugins and three MCP Servers
 * named alpha, bravo and charlie.
 */
export const withServers = (
  plugins: ReadonlyArray<Plugin>,
  body: (arranged: Arranged, servers: readonly [ServerRef, ServerRef, ServerRef]) => Promise<void>,
): Promise<void> =>
  withFleet(
    async (arranged) => {
      const servers = await createServers(
        { harness: arranged.harness, base: arranged.harness.base, token: arranged.token },
        ["alpha", "bravo", "charlie"],
      );
      await body(arranged, servers as unknown as readonly [ServerRef, ServerRef, ServerRef]);
    },
    { plugins },
  );

/** Returns the ids of the session's list of MCP Servers, in list order. */
export const listMcpServerIds = (session: Session): ReadonlyArray<string> =>
  session.mcpServers.map((entry) => entry.mcpServerId);

/** Creates an Agent on the worker profile and returns its id. */
export const createAgent = async (arranged: Arranged): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/agents",
    {
      name: "assessor",
      systemPrompt: "You assess tasks.",
      providerAccountId: findProviderAccountId(arranged, "harnesses/test"),
      permissionProfileId: (await readProfileNamed(arranged, "worker")).id,
    },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly id: string }).id;
};

export const requestUpdate = (controller: SetUpController, id: string, body: unknown) =>
  send("PATCH", controller.base, `/api/v1/mcp-servers/${id}`, { body, token: controller.token });

export const requestCheck = (controller: SetUpController, id: string, token = controller.token) =>
  post(controller.base, `/api/v1/mcp-servers/${id}/check`, {}, token);

export const readServer = async (
  controller: SetUpController,
  id: string,
): Promise<McpServerRecord> => {
  const response = await get(controller.base, `/api/v1/mcp-servers/${id}`, controller.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as McpServerRecord;
};

export interface RigOptions {
  readonly fake?: Partial<FakeUpstreamSettings>;
  readonly oauth?: boolean;
  readonly buildUpstreamRequest?: (
    credentials: Record<string, string>,
    upstream: FakeUpstream,
  ) => {
    readonly url: string;
    readonly headers: Record<string, string>;
  };
  /** How often, in milliseconds, the scheduler looks for checks that are due. Without it, it looks once a minute. */
  readonly checkInterval?: number;
  /** How long, in milliseconds, a whole check may take. Without it, a check may take 45 seconds. */
  readonly checkDeadline?: number;
}

/** What `withRig` hands the test. */
export interface Rig {
  readonly controller: SetUpController;
  readonly fake: FakeUpstream;
  readonly provider: ReturnType<typeof createDeviceProvider>;
  /** Makes a Connection of the plugin's type: pasted `t0ken`, or OAuth tokens `stored-token`. */
  readonly connect: () => Promise<string>;
}

/**
 * Starts the fake outside server, and a controller with a plugin that offers
 * it. With `oauth`, the Connection holds OAuth tokens and the refresh goes to
 * a fake provider.
 */
export const withRig = async (body: (rig: Rig) => Promise<void>, options: RigOptions = {}) => {
  const fake = await startFakeUpstream(options.fake);
  const provider = createDeviceProvider();
  const { buildUpstreamRequest } = options;
  try {
    await withSetUpController(
      async (controller) => {
        const connect = () =>
          options.oauth === true
            ? insertOauthConnection(controller.harness, {
                accessToken: "stored-token",
                refreshToken: "refresh-1",
              })
            : createConnection(controller.base, controller.token, "acme/desk", { token: "t0ken" });
        await body({ controller, fake, provider, connect });
      },
      [
        buildMcpServerPlugin("acme", {
          server:
            buildUpstreamRequest === undefined
              ? buildDeskMcpServer("acme", fake)
              : {
                  ...buildDeskMcpServer("acme", fake),
                  buildUpstreamRequest: ({ credentials }) =>
                    buildUpstreamRequest(credentials, fake),
                },
          ...(options.oauth === true ? { deviceProviderUrl: provider.base } : {}),
        }),
      ],
      {
        ...(options.checkInterval === undefined
          ? {}
          : { mcpServerCheckInterval: Duration.millis(options.checkInterval) }),
        ...(options.checkDeadline === undefined
          ? {}
          : { mcpServerCheckDeadline: Duration.millis(options.checkDeadline) }),
      },
    );
  } finally {
    await fake.stop();
    await provider.stop();
  }
};

/** What `insertUrlServerAt` stores: a pasted token makes the server's sign-in `token`, and none leaves it `none`. */
export interface UrlServerFacts {
  readonly token?: string;
  readonly name?: string;
}

/**
 * Stores a server added by URL at `url`, with its token if there is one, and
 * returns its id. The server's first check starts at the scheduler's next
 * look. It writes the rows directly, so a test can put such a server on the
 * origin of a plugin, which `create` refuses.
 */
export const insertUrlServerAt = (
  controller: Pick<SetUpController, "harness">,
  url: string,
  { token, name = "remote" }: UrlServerFacts = {},
): Promise<string> =>
  runSql(
    controller,
    Effect.gen(function* () {
      const servers = yield* mcpServerRepository;
      const at = yield* nowIso;
      const server = yield* servers.insertUrl({
        name,
        url,
        normalizedUrl: url,
        signIn: token === undefined ? "none" : "token",
        at,
      });
      if (token !== undefined) {
        yield* controller.harness.secrets.set(
          { kind: "mcp-server", id: server.id },
          "token",
          Redacted.make(token),
        );
      }
      return server.id;
    }).pipe(Effect.provideService(SqlClient.SqlClient, controller.harness.sql)),
  );

/** What `withUrlRig` hands the test. */
export interface UrlRig {
  readonly controller: SetUpController;
  readonly fake: FakeUpstream;
  /**
   * Stores a server added by URL, at the fake's address, with its token if
   * there is one, and returns its id (`insertUrlServerAt`).
   */
  readonly insertUrlServer: (facts?: UrlServerFacts) => Promise<string>;
}

/**
 * Starts the fake outside server and a controller with no plugin for it, whose
 * scheduler looks for due checks every 25 milliseconds.
 */
export const withUrlRig = async (
  body: (rig: UrlRig) => Promise<void>,
  options: Pick<RigOptions, "fake" | "checkDeadline"> = {},
) => {
  const fake = await startFakeUpstream(options.fake);
  try {
    await withSetUpController(
      async (controller) => {
        const insertUrlServer = (facts: UrlServerFacts = {}) =>
          insertUrlServerAt(controller, fake.url, facts);
        await body({ controller, fake, insertUrlServer });
      },
      [],
      {
        mcpServerCheckInterval: Duration.millis(25),
        ...(options.checkDeadline === undefined
          ? {}
          : { mcpServerCheckDeadline: Duration.millis(options.checkDeadline) }),
      },
    );
  } finally {
    await fake.stop();
  }
};

/** The scope the fake MCP server's challenge asks for. */
export const OAUTH_TEST_SCOPE = "mcp.read";

/** How the fake authorization server answers the browser, one sign-in at a time. */
export interface FakeApproval {
  /** The user says no: the redirect carries `error=access_denied` and a description. */
  readonly deny?: boolean;
  /** The `iss` the redirect carries. `null` leaves it out. By default it is the issuer, when the server sends one. */
  readonly iss?: string | null;
  /** The `state` the redirect carries, instead of the one the request had. */
  readonly state?: string;
  /** The `error` the redirect carries instead of a code, as `deny` does with `access_denied`. */
  readonly error?: string;
}

/** What the fake authorization server was asked to do, for a test to check. */
export interface FakeAuthorizationServer {
  /** The issuer identifier: the origin of the fake. */
  readonly issuer: string;
  /** The path of the token endpoint. A test changes it to move the token endpoint. */
  tokenPath: string;
  /** The path of the authorization endpoint. A test changes it to move the authorization endpoint. */
  authorizePath: string;
  /** Whether the metadata promises `iss` on authorization responses, and the redirects carry it. */
  sendsIssuer: boolean;
  /** The `expires_in`, in seconds, of every access token it issues. */
  expiresIn: number;
  /** The `token_type` of every access token it issues. */
  tokenType: string;
  /**
   * When set, registration gives the client a secret and the method
   * `client_secret_post`, and the token endpoint refuses a request without that
   * secret. By default clients are public.
   */
  issuesClientSecrets: boolean;
  /** The client secrets registration gave out, by client id. */
  readonly clientSecrets: ReadonlyMap<string, string>;
  /**
   * The `expires_in` of the access token that the code exchange issues, when
   * it differs from `expiresIn`. A test makes it 0 to get a token that is stale
   * at once, while the refreshed tokens last.
   */
  firstExpiresIn: number | undefined;
  /** When set, a refresh is refused with `invalid_grant`. */
  refuseRefresh: boolean;
  /** When set, every metadata request gets a 302 to this address. */
  redirectMetadataTo: string | undefined;
  /**
   * The `client_secret_expires_at` (seconds since the epoch) that registration
   * gives a client with a secret. By default the secret never expires.
   */
  secretExpiresAt: number | undefined;
  /** Makes the fake forget every client it registered, as an authorization server that purged them. */
  forgetClients: () => void;
  /**
   * Makes the token endpoint hold the answer to every code exchange from now
   * on, once it has received the request, until the returned function is
   * called. The test waits for the request in `tokenRequests`.
   */
  holdCodeExchange: () => () => void;
  /** The forms the token endpoint received. */
  readonly tokenRequests: ReadonlyArray<Record<string, string>>;
  /** The JSON bodies the registration endpoint received. */
  readonly registrations: ReadonlyArray<Record<string, unknown>>;
  /** The address the browser was sent to for each authorization request. */
  readonly authorizationRequests: ReadonlyArray<URL>;
  /**
   * Does what the browser does when the user signs in: opens the address, and
   * returns the address of the redirect it gets back, the one a client
   * catches or the user pastes.
   */
  approve: (authorizationUrl: string, approval?: FakeApproval) => Promise<string>;
  /** Whether an `Authorization` header carries an access token that was issued and not revoked. */
  accepts: (authorization: string | null) => boolean;
  /** The access token issued last. */
  currentAccessToken: () => string;
  /** Makes the fake MCP server refuse every access token issued so far, as a server that revoked them does. */
  revokeAccessTokens: () => void;
  /** Whether `stop` was called. */
  stopped: boolean;
  /** Makes the fake answer HTTP 503 to every request, as an authorization server that is down. */
  stop: () => void;
}

/**
 * Starts a fake OAuth authorization server on the origin of the fake MCP server. It serves
 * the metadata, Dynamic Client Registration, an authorization endpoint that
 * redirects with a code, and a token endpoint that checks what a real one
 * checks (PKCE, the redirect address, the client, the `resource`) and rotates
 * its refresh tokens. It never calls a real vendor.
 *
 * `upstream` is the fake MCP server it protects: the fake publishes the
 * server's protected resource metadata there, makes the server's 401 point at
 * it, and lets the server accept only the tokens it issued.
 */
export const startFakeAuthorizationServer = (upstream: FakeUpstream): FakeAuthorizationServer => {
  const issuer = upstream.origin;
  const codes = new Map<
    string,
    { readonly challenge: string; readonly redirectUri: string; readonly clientId: string }
  >();
  const clients = new Set<string>();
  const clientSecrets = new Map<string, string>();
  const refreshTokens = new Set<string>();
  let accessTokens = new Set<string>();
  let issued = 0;
  let lastAccessToken = "";
  let heldExchange: Promise<void> | undefined;
  const tokenRequests: Array<Record<string, string>> = [];
  const registrations: Array<Record<string, unknown>> = [];
  const authorizationRequests: Array<URL> = [];
  const resourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";

  const issueTokens = (): Response => {
    issued += 1;
    lastAccessToken = `access-token-${String(issued)}`;
    const refreshToken = `refresh-token-${String(issued)}`;
    accessTokens.add(lastAccessToken);
    refreshTokens.add(refreshToken);
    return Response.json({
      access_token: lastAccessToken,
      refresh_token: refreshToken,
      token_type: fake.tokenType,
      expires_in: issued === 1 ? (fake.firstExpiresIn ?? fake.expiresIn) : fake.expiresIn,
    });
  };
  const refuse = (error: string) => Response.json({ error }, { status: 400 });

  /**
   * Answers a request of the authorization server, or returns `undefined` for
   * any other. The fake MCP server calls it first, because the authorization
   * server has the MCP server's own origin: Hercule accepts an http
   * authorization server only on the origin of an http MCP server.
   */
  const handle = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isMine = [
      "/.well-known/oauth-authorization-server",
      "/register",
      fake.authorizePath,
      fake.tokenPath,
    ].includes(url.pathname);
    if (isMine && fake.stopped) return new Response("down", { status: 503 });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      if (fake.redirectMetadataTo !== undefined) {
        return new Response(null, {
          status: 302,
          headers: { location: fake.redirectMetadataTo },
        });
      }
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}${fake.authorizePath}`,
        token_endpoint: `${issuer}${fake.tokenPath}`,
        registration_endpoint: `${issuer}/register`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        ...(fake.sendsIssuer ? { authorization_response_iss_parameter_supported: true } : {}),
      });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      registrations.push(body);
      const clientId = `client-${String(registrations.length)}`;
      clients.add(clientId);
      if (fake.issuesClientSecrets) {
        const secret = `dcr-secret-${Math.random().toString(36).slice(2)}`;
        clientSecrets.set(clientId, secret);
        return Response.json(
          {
            ...body,
            client_id: clientId,
            client_secret: secret,
            ...(fake.secretExpiresAt === undefined
              ? {}
              : { client_secret_expires_at: fake.secretExpiresAt }),
            token_endpoint_auth_method: "client_secret_post",
          },
          { status: 201 },
        );
      }
      return Response.json(
        { ...body, client_id: clientId, token_endpoint_auth_method: "none" },
        { status: 201 },
      );
    }
    if (url.pathname === fake.authorizePath) {
      authorizationRequests.push(url);
      const params = url.searchParams;
      const redirect = URL.parse(params.get("redirect_uri") ?? "");
      const problems = [
        params.get("response_type") === "code" ? "" : "response_type",
        clients.has(params.get("client_id") ?? "") ? "" : "client_id",
        redirect?.hostname === "127.0.0.1" && redirect.pathname === "/callback"
          ? ""
          : "redirect_uri",
        params.get("code_challenge_method") === "S256" ? "" : "code_challenge_method",
        params.get("code_challenge") ? "" : "code_challenge",
        params.get("state") ? "" : "state",
        params.get("resource") === upstream.url ? "" : "resource",
        params.get("scope") === OAUTH_TEST_SCOPE ? "" : "scope",
      ].filter((problem) => problem !== "");
      if (problems.length > 0)
        return new Response(`bad request: ${problems.join(",")}`, { status: 400 });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === fake.tokenPath && request.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(await request.text()));
      tokenRequests.push(form);
      if (!clients.has(form.client_id ?? "")) return refuse("invalid_client");
      const secret = clientSecrets.get(form.client_id ?? "");
      if (secret !== undefined && form.client_secret !== secret) return refuse("invalid_client");
      if (form.resource !== upstream.url) return refuse("invalid_target");
      if (form.grant_type === "refresh_token") {
        if (fake.refuseRefresh) return refuse("invalid_grant");
        const token = form.refresh_token ?? "";
        if (!refreshTokens.has(token)) return refuse("invalid_grant");
        // A rotating provider: the old refresh token dies the moment it is used.
        refreshTokens.delete(token);
        return issueTokens();
      }
      await heldExchange;
      const code = codes.get(form.code ?? "");
      if (form.grant_type !== "authorization_code" || code === undefined)
        return refuse("invalid_grant");
      codes.delete(form.code ?? "");
      if (
        code.redirectUri !== form.redirect_uri ||
        code.clientId !== form.client_id ||
        computeChallenge(form.code_verifier ?? "") !== code.challenge
      ) {
        return refuse("invalid_grant");
      }
      return issueTokens();
    }
    return undefined;
  };

  const fake: FakeAuthorizationServer = {
    issuer,
    tokenPath: "/token",
    authorizePath: "/authorize",
    sendsIssuer: true,
    expiresIn: 3600,
    tokenType: "Bearer",
    issuesClientSecrets: false,
    clientSecrets,
    firstExpiresIn: undefined,
    secretExpiresAt: undefined,
    forgetClients: () => clients.clear(),
    holdCodeExchange: () => {
      let release = () => {};
      heldExchange = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        heldExchange = undefined;
        release();
      };
    },
    refuseRefresh: false,
    redirectMetadataTo: undefined,
    tokenRequests,
    registrations,
    authorizationRequests,
    approve: async (authorizationUrl, approval = {}) => {
      const request = new URL(authorizationUrl);
      const answered = await fetch(request, { redirect: "manual" });
      if (answered.status !== 204) {
        throw new Error(`the fake authorization server refused: ${await answered.text()}`);
      }
      const redirectUri = request.searchParams.get("redirect_uri") as string;
      const callback = new URL(redirectUri);
      const code = `code-${String(codes.size + 1)}-${Math.random().toString(36).slice(2)}`;
      callback.searchParams.set(
        "state",
        approval.state ?? (request.searchParams.get("state") as string),
      );
      if (approval.deny === true || approval.error !== undefined) {
        callback.searchParams.set("error", approval.error ?? "access_denied");
        callback.searchParams.set("error_description", "the user said SECRET-DESCRIPTION");
      } else {
        callback.searchParams.set("code", code);
        codes.set(code, {
          challenge: request.searchParams.get("code_challenge") as string,
          redirectUri,
          clientId: request.searchParams.get("client_id") as string,
        });
      }
      const iss =
        approval.iss === undefined ? (fake.sendsIssuer ? fake.issuer : null) : approval.iss;
      if (iss !== null) callback.searchParams.set("iss", iss);
      return callback.href;
    },
    accepts: (authorization) =>
      authorization !== null &&
      authorization.startsWith("Bearer ") &&
      accessTokens.has(authorization.slice("Bearer ".length)),
    currentAccessToken: () => lastAccessToken,
    revokeAccessTokens: () => {
      accessTokens = new Set();
    },
    stopped: false,
    stop: () => {
      fake.stopped = true;
    },
  };

  upstream.challenge = `Bearer resource_metadata="${upstream.origin}${resourceMetadataPath}", scope="${OAUTH_TEST_SCOPE}"`;
  upstream.authorize = (authorization) => fake.accepts(authorization);
  upstream.answerFirst = (request) =>
    new URL(request.url).pathname === resourceMetadataPath
      ? Response.json({
          resource: upstream.url,
          authorization_servers: [fake.issuer],
          scopes_supported: ["other.scope"],
        })
      : handle(request);
  return fake;
};

/** What `withOAuthRig` hands the test. */
export interface OAuthRig extends UrlRig {
  readonly authorizationServer: FakeAuthorizationServer;
}

/**
 * Starts the fake MCP server, a fake authorization server that protects it,
 * and a controller with no plugin, as `withUrlRig` does. The MCP server accepts
 * only the access tokens the authorization server issued.
 */
export const withOAuthRig = async (
  body: (rig: OAuthRig) => Promise<void>,
  options: Pick<RigOptions, "fake"> = {},
) => {
  await withUrlRig(async (rig) => {
    await body({ ...rig, authorizationServer: startFakeAuthorizationServer(rig.fake) });
  }, options);
};

/**
 * Rotates the tokens a signed-in server holds, as a refresh made by another
 * caller would: it exchanges the stored refresh token at the fake
 * authorization server and stores the new tokens, which the fake MCP server
 * accepts. The old access token stays valid. The server's sign-in generation
 * stays the same.
 */
export const rotateSignInTokens = async (rig: OAuthRig, serverId: string): Promise<void> => {
  const owner = { kind: "mcp-server", id: serverId } as const;
  const stored = await runSql(rig.controller, rig.controller.harness.secrets.get(owner, "oauth"));
  if (Option.isNone(stored)) throw new Error("the server holds no OAuth sign-in");
  const signIn = JSON.parse(Redacted.value(stored.value)) as {
    readonly tokenEndpoint: string;
    readonly resource: string;
    readonly client: { readonly clientId: string };
    readonly tokens: { readonly refreshToken: string };
  };
  const answer = await fetch(signIn.tokenEndpoint, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: signIn.tokens.refreshToken,
      client_id: signIn.client.clientId,
      resource: signIn.resource,
    }),
  });
  const body = (await answer.json()) as {
    readonly access_token: string;
    readonly refresh_token: string;
    readonly expires_in: number;
  };
  const obtainedAt = new Date();
  await runSql(
    rig.controller,
    rig.controller.harness.secrets.set(
      owner,
      "oauth",
      Redacted.make(
        JSON.stringify({
          ...signIn,
          tokens: {
            accessToken: body.access_token,
            refreshToken: body.refresh_token,
            expiresAt: new Date(obtainedAt.getTime() + body.expires_in * 1000).toISOString(),
            obtainedAt: obtainedAt.toISOString(),
          },
        }),
      ),
    ),
  );
};

/** The redirect address a test's sign-in returns to: a port nothing listens on. */
export const TEST_REDIRECT_URI = "http://127.0.0.1:50123/callback";

/** Sends `mcpServer.startSignIn` and returns the raw response. */
export const requestStartSignIn = (
  controller: SetUpController,
  id: string,
  redirectUri = TEST_REDIRECT_URI,
) => post(controller.base, `/api/v1/mcp-servers/${id}/sign-in`, { redirectUri }, controller.token);

/** Sends `mcpServer.finishSignIn` and returns the raw response. */
export const requestFinishSignIn = (
  controller: SetUpController,
  id: string,
  callbackQuery: string,
) =>
  post(
    controller.base,
    `/api/v1/mcp-servers/${id}/sign-in/finish`,
    { callbackQuery },
    controller.token,
  );

/** Starts a sign-in, which must work, and returns the address to open. */
export const startSignIn = async (
  controller: SetUpController,
  id: string,
  redirectUri = TEST_REDIRECT_URI,
): Promise<{ readonly authorizationUrl: string; readonly expiresAt: string }> => {
  const response = await requestStartSignIn(controller, id, redirectUri);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as {
    readonly authorizationUrl: string;
    readonly expiresAt: string;
  };
};

/**
 * Signs a server in through the fake authorization server, start to finish,
 * and returns the server as the finish answered. Both calls must work.
 */
export const signInWithBrowser = async (
  rig: OAuthRig,
  serverId: string,
  approval?: FakeApproval,
): Promise<McpServerRecord> => {
  const { authorizationUrl } = await startSignIn(rig.controller, serverId);
  const callback = await rig.authorizationServer.approve(authorizationUrl, approval);
  return readRecord(await requestFinishSignIn(rig.controller, serverId, callback));
};

export const refreshedToken = () =>
  buildJsonResponse({
    access_token: "refreshed-token",
    refresh_token: "refresh-2",
    token_type: "bearer",
    expires_in: 8 * 60 * 60,
  });

/** The facts of one catalogue view a test sets. A fact left out is the healthy one. */
export interface ViewFacts {
  readonly enabled?: boolean;
  readonly status?: McpServerStatus;
  /** `null` is a server that has no stored tool list yet. */
  readonly checkedAt?: string | null;
  readonly plugin?: PluginState["_tag"];
  /** `gone` is a Connection that no longer exists. */
  readonly connection?: ConnectionStatus | "gone";
  /** The type of the Connection. The plugin of the view needs `acme/desk`. */
  readonly connectionType?: string;
  /** Makes the server one added by URL, with this sign-in. It has no plugin or Connection. */
  readonly url?: { readonly signIn: "none" | "token" | "oauth" };
}

/** Builds the view of one MCP Server from the facts given, without a database. */
export const buildMcpServerView = ({
  enabled = true,
  status = "ready",
  checkedAt = "2026-01-01T00:00:00.000Z",
  plugin = "active",
  connection = "connected",
  connectionType = "acme/desk",
  url,
}: ViewFacts = {}): McpServerView => {
  const at = "2026-01-01T00:00:00.000Z";
  const urlSource: McpServerUrlSource | undefined =
    url === undefined
      ? undefined
      : {
          kind: "url",
          url: "https://desk.example/mcp",
          normalizedUrl: "https://desk.example/mcp",
          signIn: url.signIn,
          signInOffered: null,
        };
  return {
    server: {
      id: "server-1",
      name: "desk",
      source: urlSource ?? {
        kind: "plugin",
        contributionId: "acme/desk",
        connectionId: "connection-1",
        accountId: "desk-1",
      },
      enabled,
      status,
      statusDetail: null,
      statusCause: null,
      tools: [],
      checkedAt,
      protocolVersion: null,
      revision: 0,
      connectionGeneration: 0,
      notifiedStatus: null,
      nextCheckAt: null,
      failedChecks: 0,
      createdAt: at,
      updatedAt: at,
    },
    dependencies:
      urlSource !== undefined
        ? { kind: "url", source: urlSource }
        : {
            kind: "plugin",
            connection:
              connection === "gone"
                ? undefined
                : {
                    id: "connection-1",
                    pluginId: "acme",
                    type: connectionType,
                    label: "work",
                    displayName: "Desk",
                    accountId: "desk-1",
                    status: connection,
                    statusDetail: undefined,
                    warning: undefined,
                    labels: [],
                    config: {},
                    feedIntervals: {},
                    intake: NO_INTAKE_OVERRIDES,
                    credentialsGeneration: 0,
                    createdAt: at,
                    updatedAt: at,
                  },
            plugin:
              plugin === "active"
                ? {
                    _tag: "active",
                    contribution: {
                      id: "acme/desk",
                      pluginId: "acme",
                      displayName: "Desk",
                      description: "",
                      connectionType: "acme/desk",
                      origin: "https://desk.example",
                      buildUpstreamRequest: () => {
                        throw new Error("a test of a view never builds a request");
                      },
                    },
                  }
                : plugin === "missing"
                  ? { _tag: "missing" }
                  : { _tag: plugin, pluginName: "Desk" },
          },
  };
};

/** Returns how many units of admitted work the promotion gate counts as running now. */
export const readRunningWork = (promotion: ServerHarness["promotion"]) =>
  Effect.runPromise(
    Effect.map(Stream.runHead(promotion.gateChanges), (state) => Option.getOrThrow(state).running),
  );
