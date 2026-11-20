/**
 * Tests the rules for what may leave the controller towards an outside MCP
 * server, and the fixed messages of its failures:
 *
 * - a URL may carry credentials only when it is `http` or `https`, exactly on
 *   the plugin's origin, and has no user name or password;
 * - every failure of the MCP client becomes one failure reason with a message
 *   that never holds what the server sent, and a 401 names the credentials it
 *   rejected;
 * - the fallback to an older MCP revision follows MCP's versioning rules, also
 *   against a server built on the official TypeScript SDK: it happens when the
 *   server shows it does not speak the modern handshake, and never on a 401,
 *   403, 429, 5xx, a transport failure or a timeout;
 * - the HTTP requests to the outside server create no trace span, so no URL or
 *   error text reaches a trace;
 * - each call's requests carry that call's own credentials, whatever another
 *   call that shares the client sends, and a call records the answer to its own
 *   `tools/call` request apart from any other request it causes. Of the
 *   credential values it sent, it records only those long enough to be removed
 *   from answers.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { McpClientError, McpProtocol } from "effect/ai";
import { TestDatabase } from "../db/testing";
import { ServingPromotionStateLayer } from "../promotion/testing";
import { startFakeUpstream, type FakeUpstream } from "./testing";
import {
  checkUrlOnOrigin,
  createUpstreamCallState,
  CurrentUpstreamCall,
  describeClientFailure,
  openUpstream,
} from "./upstream";

const ORIGIN = "https://mcp.example.com";

describe("checkUrlOnOrigin", () => {
  it("accepts a path and a query on the origin", () => {
    expect(checkUrlOnOrigin(ORIGIN, "https://mcp.example.com/mcp?x=1")).toBeUndefined();
  });

  it.each([
    ["another host", "https://evil.example.com/mcp"],
    ["another port", "https://mcp.example.com:8443/mcp"],
    ["another scheme", "http://mcp.example.com/mcp"],
    ["a user name", "https://user@mcp.example.com/mcp"],
    ["a password", "https://user:secret@mcp.example.com/mcp"],
    ["a scheme that is not http", "ftp://mcp.example.com/mcp"],
    ["a string that is not a URL", "not a url"],
    ["a host that only starts like the origin", "https://mcp.example.com.evil.test/mcp"],
  ])("refuses %s without sending", (_name, url) => {
    expect(checkUrlOnOrigin(ORIGIN, url)).toMatchObject({
      _tag: "UpstreamError",
      reason: "not-on-origin",
    });
  });
});

describe("describeClientFailure", () => {
  const fail = (reason: ConstructorParameters<typeof McpClientError.McpClientError>[0]["reason"]) =>
    new McpClientError.McpClientError({ reason });

  it("names the credentials that were rejected on a 401", () => {
    const failure = describeClientFailure(
      fail(new McpClientError.HttpError({ status: 401, description: "the secret body" })),
      "identity-1",
    );

    expect(failure).toMatchObject({ reason: "unauthorized", sentIdentity: "identity-1" });
    expect(failure.message).not.toContain("secret");
  });

  it("maps each kind of client failure to a reason, with a message that holds nothing the server sent", () => {
    const cases = [
      [new McpClientError.TransportError({ description: "ECONNREFUSED 10.0.0.1" }), "unreachable"],
      [new McpClientError.TimeoutError({ operation: "tools/list" }), "timeout"],
      [
        new McpClientError.LimitError({ description: "MCP message exceeds maxMessageBytes" }),
        "too-large",
      ],
      [new McpClientError.ProtocolError({ description: "a body the server wrote" }), "protocol"],
      [
        new McpClientError.HttpError({ status: 400, description: "a body the server wrote" }),
        "protocol",
      ],
      [new McpClientError.HttpError({ status: 403 }), "protocol"],
      [new McpClientError.HttpError({ status: 404 }), "protocol"],
      [new McpClientError.HttpError({ status: 302 }), "protocol"],
      [new McpClientError.HttpError({ status: 500 }), "unreachable"],
      [new McpClientError.HttpError({ status: 503 }), "unreachable"],
      [new McpClientError.HttpError({ status: 429 }), "unreachable"],
      [new McpClientError.ClosedError({ description: "MCP HTTP transport closed" }), "unreachable"],
      [new McpClientError.ClosedError({ sessionExpired: true }), "protocol"],
      [new McpClientError.HttpError({ status: 400, code: -32022 }), "unsupported-revision"],
    ] as const;

    for (const [reason, expected] of cases) {
      const failure = describeClientFailure(fail(reason), undefined);
      expect(failure.reason, reason._tag).toBe(expected);
      expect(failure.message).not.toMatch(/ECONNREFUSED|10\.0\.0\.1|body the server wrote/);
    }
  });
});

/** Opens an upstream to the fake with the credentials of nobody, and returns the outcome. */
const openUpstreamTo = (fake: FakeUpstream, firstRevision: string | null = null) =>
  Effect.runPromise(
    Effect.result(
      Effect.scoped(
        openUpstream({
          contribution: {
            id: "sentry/desk",
            pluginId: "sentry",
            displayName: "Desk",
            description: "",
            connectionType: "sentry/desk",
            origin: fake.origin,
            buildUpstreamRequest: () => ({ url: fake.url, headers: {} }),
          },
          credentials: { credentials: {}, config: {}, identity: "identity-1" },
          firstRevision,
        }).pipe(Effect.map((opened) => opened.revision)),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(ServingPromotionStateLayer),
        Effect.provide(TestDatabase),
      ),
    ),
  );

describe("the fallback to an older MCP revision", () => {
  it.each([
    ["2025-06-18", McpProtocol.v2025_06_18],
    ["2025-03-26", McpProtocol.v2025_03_26],
  ])(
    "reaches a server built on the official SDK that speaks only %s, which answers server/discover with HTTP 400 and code -32000",
    async (revision, protocol) => {
      const fake = await startFakeUpstream({
        protocols: [protocol],
        answersLikeOfficialSdk: true,
      });
      try {
        const outcome = await openUpstreamTo(fake);

        expect(outcome).toMatchObject({ _tag: "Success", success: revision });
        // The modern handshake is refused first, the way the SDK refuses it.
        expect(fake.requests[0]).toMatchObject({ method: "server/discover", status: 400 });
        expect(fake.requests.at(-1)?.method).not.toBe("server/discover");
      } finally {
        await fake.stop();
      }
    },
  );

  it.each([
    [401, "unauthorized", 1],
    [403, "protocol", 1],
    [429, "unreachable", 1],
    [503, "unreachable", 1],
    // A 404 or a 405 to server/discover shows an older server, but `initialize` gets the same answer, which ends it.
    [404, "protocol", 2],
    [405, "protocol", 2],
  ])(
    "does not fall back when the server answers HTTP %i to every request: the failure is %s, after %i request(s)",
    async (status, reason, requestCount) => {
      const fake = await startFakeUpstream();
      fake.refuseWithStatus = status;
      try {
        const outcome = await openUpstreamTo(fake);

        expect(outcome).toMatchObject({ _tag: "Failure", failure: { reason } });
        expect(fake.requests).toHaveLength(requestCount);
      } finally {
        await fake.stop();
      }
    },
  );
});

describe("openUpstream", () => {
  it("gives each call's requests that call's own credentials, and records the answer to its tool request", async () => {
    const fake = await startFakeUpstream();
    try {
      const credentialsOf = (token: string) => ({
        // `org` is too short to count as a secret that must be removed from answers.
        credentials: { token, org: "acme" },
        config: {},
        identity: `identity-${token}`,
      });
      const first = createUpstreamCallState(Effect.succeed(credentialsOf("token-one-1234")));
      const second = createUpstreamCallState(Effect.succeed(credentialsOf("token-two-5678")));

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* openUpstream({
              contribution: {
                id: "sentry/desk",
                pluginId: "sentry",
                displayName: "Desk",
                description: "",
                connectionType: "sentry/desk",
                origin: fake.origin,
                buildUpstreamRequest: ({ credentials }) => ({
                  url: fake.url,
                  headers: { Authorization: `Bearer ${credentials["token"] ?? ""}` },
                }),
              },
              credentials: credentialsOf("opening-token-0"),
              firstRevision: null,
            });
            const [tool] = yield* opened.client.listTools();
            if (tool === undefined) return yield* Effect.die("the fake lists no tool");
            const callWith = (state: typeof first) =>
              opened.client
                .callTool({ tool, arguments: { text: "hi" } })
                .pipe(Effect.provideService(CurrentUpstreamCall, state));
            yield* Effect.all([callWith(first), callWith(second)], { concurrency: 2 });
          }),
        ).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(ServingPromotionStateLayer),
          Effect.provide(TestDatabase),
        ),
      );

      const sent = fake.requests
        .filter((request) => request.method === "tools/call")
        .map((request) => request.authorization)
        .sort();
      expect(sent).toEqual(["Bearer token-one-1234", "Bearer token-two-5678"]);
      expect(first).toMatchObject({
        sentCredentials: credentialsOf("token-one-1234"),
        toolPostSent: true,
        toolPostStatus: 200,
      });
      expect([...second.sentValues].sort()).toEqual(["Bearer token-two-5678", "token-two-5678"]);
    } finally {
      await fake.stop();
    }
  });

  it("creates no trace span for the requests it sends", async () => {
    const fake = await startFakeUpstream();
    try {
      const spans: Array<string> = [];
      const recordingTracer = Tracer.make({
        span(options) {
          spans.push(options.name);
          return Tracer.nativeTracer.span.call(this, options);
        },
      });

      const tools = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* openUpstream({
              contribution: {
                id: "sentry/desk",
                pluginId: "sentry",
                displayName: "Desk",
                description: "",
                connectionType: "sentry/desk",
                origin: fake.origin,
                buildUpstreamRequest: () => ({ url: fake.url, headers: {} }),
              },
              credentials: { credentials: {}, config: {}, identity: "identity-1" },
              firstRevision: null,
            });
            return yield* opened.client.listTools();
          }),
        ).pipe(
          Effect.provideService(Tracer.Tracer, recordingTracer),
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(ServingPromotionStateLayer),
          Effect.provide(TestDatabase),
        ),
      );

      expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect(spans).toEqual([]);
    } finally {
      await fake.stop();
    }
  });
});
