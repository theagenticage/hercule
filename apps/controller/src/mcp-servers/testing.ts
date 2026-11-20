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
 * - whether it holds every answer until the test lets go.
 *
 * It decides what to answer when a request arrives, and holds the answer
 * after that, so a test can change what the fake does while an answer is on
 * its way. It records every request's JSON-RPC method, address,
 * `Authorization` header and `Mcp-Protocol-Version` header, so a test can
 * check what the controller sent.
 *
 * The helpers below the fake are the ones every test of an MCP Server's
 * checks and operations shares: reading the stored row, creating a server and
 * waiting for a result.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { expect } from "vitest";
import type { McpServer as McpServerRecord } from "@hercule/contract";
import { connectionRepository, OAUTH_TOKENS } from "../connections";
import { nowIso, withTransaction } from "../db";
import { get, post, send, type ServerHarness } from "../http/testing";
import type { SetUpController } from "../workflows/testing";

/** One tool the fake lists. Calling it answers with no content. */
export interface FakeTool {
  readonly name: string;
  readonly description: string;
}

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
  /** The path and query of the address the request went to. */
  readonly url: string;
  readonly authorization: string | null;
  readonly protocolVersion: string | null;
  status: number | undefined;
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
  /** When set, every request gets a 302 to this address instead of an answer. */
  redirectTo: string | undefined;
  /** When set, every request gets this HTTP status and an empty body instead of an answer. */
  refuseWithStatus: number | undefined;
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
          handle: () => Effect.succeed(new McpSchema.CallToolResult({ content: [] })),
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
      let method = "?";
      try {
        const body = (await request.clone().json()) as { readonly method?: unknown };
        if (typeof body.method === "string") method = body.method;
      } catch {
        // A request with no JSON body, such as a DELETE, has no method.
      }
      const address = new URL(request.url);
      const recorded: RecordedRequest = {
        method,
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
                  headers: { "www-authenticate": "Bearer" },
                })
              : ((settings.answersLikeOfficialSdk
                  ? buildSdkRefusal(request, method, settings)
                  : undefined) ?? (await built.handler(request, Context.empty())));
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
    redirectTo: undefined,
    refuseWithStatus: undefined,
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
  tokens: { readonly accessToken: string; readonly refreshToken: string },
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
}

/** Runs a statement on the controller's database in its own transaction, for state no operation reaches. */
export const runSql = <A>(controller: SetUpController, statement: Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.orDie(withTransaction(controller.harness.sql, statement)));

/** Reads the stored row of the only server there is. */
export const readRow = async (controller: SetUpController): Promise<McpServerRow> => {
  const sql = controller.harness.sql;
  const rows = await runSql(
    controller,
    sql<McpServerRow>`SELECT status, status_detail, status_cause, tools, checked_at,
                             protocol_version, revision, connection_generation, failed_checks,
                             next_check_at, updated_at, notified_status
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
