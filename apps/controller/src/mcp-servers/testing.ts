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
 * It records every request's method, `Authorization` header and
 * `Mcp-Session-Id` header, so a test can check what the controller sent.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import {
  HOST_API,
  registerConnectionType,
  registerMcpServer,
  type Plugin,
} from "@hercule/plugin-host";
import { connectionRepository, OAUTH_TOKENS } from "../connections";
import { nowIso, withTransaction } from "../db";
import type { ServerHarness } from "../http/testing";

/** One tool the fake lists. Calling it answers `echo:<text>`. */
export interface FakeTool {
  readonly name: string;
  readonly description: string;
}

/** What the fake can be asked to speak and list. */
export interface FakeUpstreamSettings {
  /** The MCP revisions the fake speaks. The default is the two newest. */
  readonly protocols: ReadonlyArray<McpProtocol.ProtocolAdapter>;
  readonly tools: ReadonlyArray<FakeTool>;
}

/** One request the fake received. `status` is `undefined` while the fake still holds the answer. */
export interface RecordedRequest {
  /** The JSON-RPC method, or `?` for a request that carries none, such as a DELETE. */
  readonly method: string;
  readonly httpMethod: string;
  readonly authorization: string | null;
  readonly sessionId: string | null;
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
   * Decides whether a request with this `Authorization` header is let in. A
   * request that is not gets HTTP 401. The default lets every request in.
   */
  authorize: (authorization: string | null) => boolean;
  /** When set, every request gets a 302 to this address instead of an answer. */
  redirectTo: string | undefined;
  /** Replaces the revisions it speaks and the tools it lists, for the requests that follow. */
  configure: (settings: Partial<FakeUpstreamSettings>) => Promise<void>;
  /**
   * Makes the fake hold the answer to every request, from now on, until the
   * returned function is called.
   */
  hold: () => () => void;
  /** Resolves once the fake has received `count` requests in all. */
  waitForRequests: (count: number) => Promise<void>;
  stop: () => Promise<void>;
}

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
          handle: (payload: { readonly text?: string }) =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                content: [{ type: "text", text: `echo:${payload.text ?? ""}` }],
              }),
            ),
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
  };
  let built = buildHandler(settings);
  const requests: Array<RecordedRequest> = [];
  const arrivals: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  let held: Promise<void> | undefined;
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
      const recorded: RecordedRequest = {
        method,
        httpMethod: request.method,
        authorization: request.headers.get("authorization"),
        sessionId: request.headers.get("mcp-session-id"),
        protocolVersion: request.headers.get("mcp-protocol-version"),
        status: undefined,
      };
      // Decided on arrival, so a test can change the rule while the answer is held.
      const authorized = fake.authorize(recorded.authorization);
      requests.push(recorded);
      for (const waiting of arrivals.filter((one) => requests.length >= one.count)) {
        waiting.resolve();
      }
      if (held !== undefined) await held;
      if (fake.redirectTo !== undefined) {
        recorded.status = 302;
        return new Response(null, { status: 302, headers: { location: fake.redirectTo } });
      }
      if (!authorized) {
        recorded.status = 401;
        return new Response("unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      const response = await built.handler(request, Context.empty());
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
    configure: async (changes) => {
      settings = { ...settings, ...changes };
      const previous = built;
      built = buildHandler(settings);
      await previous.dispose();
    },
    hold: () => {
      let release: () => void = () => undefined;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
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

/** The id of the plugin `buildUpstreamDeskPlugin` builds when it is given none. */
export const DESK_PLUGIN_ID = "acme";

/**
 * Builds a plugin that offers one MCP server, `<id>/desk`, whose server is
 * `fake`, with the Connection type `<id>/desk` to reach it.
 *
 * The Connection holds a pasted `token`, or, when `deviceProviderUrl` is
 * given, OAuth tokens that refresh at that provider. The server's requests
 * carry the token as `Authorization: Bearer <token>`.
 */
export const buildUpstreamDeskPlugin = (
  fake: Pick<FakeUpstream, "url" | "origin">,
  options: {
    readonly id?: string;
    /** The provider that refreshes the Connection's OAuth tokens. Without it the Connection holds a pasted token. */
    readonly deviceProviderUrl?: string;
    /** Builds the request in place of the plugin's own. */
    readonly buildUpstreamRequest?: (credentials: Record<string, string>) => {
      readonly url: string;
      readonly headers: Record<string, string>;
    };
  } = {},
): Plugin => {
  const id = options.id ?? DESK_PLUGIN_ID;
  const providerUrl = options.deviceProviderUrl;
  return {
    manifest: {
      id,
      displayName: "Acme",
      hostApi: HOST_API,
      capabilities: ["connections", "mcp-servers"],
      configSchema: Schema.Struct({}),
    },
    register: (host) =>
      Effect.andThen(
        registerConnectionType(host, {
          type: "desk",
          displayName: "Desk",
          ...(providerUrl === undefined
            ? { setup: [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }] }
            : {
                setup: [{ kind: "device" }],
                device: {
                  clientId: "desk-client",
                  deviceCodeUrl: `${providerUrl}/device/code`,
                  tokenUrl: `${providerUrl}/token`,
                  scopes: [],
                },
              }),
          validate: () => Effect.succeed({ displayName: "Desk", accountId: "desk-1" }),
        }),
        registerMcpServer(host, {
          id: "desk",
          displayName: "Desk",
          description: "Read and update Desk tickets.",
          connectionType: `${id}/desk`,
          origin: fake.origin,
          buildUpstreamRequest: ({ credentials }) =>
            options.buildUpstreamRequest?.(credentials) ?? {
              url: fake.url,
              headers: {
                Authorization: `Bearer ${credentials["token"] ?? credentials["accessToken"] ?? ""}`,
              },
            },
        }),
      ),
    activate: () => Effect.succeed(Effect.void),
  };
};

/**
 * Stores a Connection of the OAuth flavor of `buildUpstreamDeskPlugin`, with
 * these tokens, and returns its id. No operation makes one without a browser,
 * so the test writes the rows the sign-in would.
 */
export const insertOauthConnection = (
  harness: ServerHarness,
  tokens: { readonly accessToken: string; readonly refreshToken: string },
  pluginId = DESK_PLUGIN_ID,
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
              type: `${pluginId}/desk`,
              label: "work",
              displayName: "Desk",
              accountId: "desk-1",
              labels: [],
              config: {},
              at,
            });
            yield* harness.secrets.set(
              { kind: "connection", id: row.id },
              OAUTH_TOKENS,
              Redacted.make(
                JSON.stringify({
                  ...tokens,
                  expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
                }),
              ),
            );
            return row.id;
          }),
        );
      }).pipe(Effect.provideService(SqlClient.SqlClient, harness.sql)),
    ),
  );
