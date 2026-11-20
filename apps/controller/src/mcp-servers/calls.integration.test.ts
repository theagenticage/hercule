/**
 * Tests what the MCP Gateway asks of `McpServerCalls` - which servers it may
 * serve, a call of one tool, and ending a token's upstream sessions - against a
 * real controller and a fake outside MCP server that speaks the protocol for
 * real:
 *
 * - which servers are servable, and what a refused call says for each reason;
 * - a call is answered, with the original tool name and the arguments;
 * - upstream MCP sessions: one per Session Token and server, shared by
 *   concurrent first calls, replaced when the server or its Connection's
 *   credentials moved, replaced once when the server expired one, and ended
 *   with the token;
 * - a 401 to the call's own request: one refresh, the same upstream session,
 *   one more try, and the outcome for each way the refresh can end;
 * - what changes a server's status and what is only the call's answer;
 * - the deadline, the size cap, the `authorize` check before every send, and a
 *   frozen controller.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import * as Fiber from "effect/Fiber";
import { McpProtocol } from "effect/ai";
import { buildJsonResponse, readConnection } from "../connections/testing";
import { McpCallDeadline, McpCallRefused, type McpToolCall } from "./calls";
import {
  countNotifications,
  eventually,
  readRow,
  refreshedToken,
  requestUpdate,
  runSql,
  waitForResult,
  createServer,
  withRig,
  type FakeUpstream,
  type Rig,
  type RigOptions,
} from "./testing";

const TOOLS = [
  { name: "echo", description: "Echoes its arguments" },
  { name: "fail", description: "Fails on its own", answer: "tool-error" as const },
  { name: "bad", description: "Refuses its arguments", answer: "rpc-error" as const },
  { name: "big", description: "Answers too much", answer: "too-large" as const },
];

/** The Session Token hashes the tests call as. */
const SCOPE_A = "scope-a";
const SCOPE_B = "scope-b";

/** What a test gets once the server is `ready`. */
interface ReadyRig extends Rig {
  readonly serverId: string;
  readonly connectionId: string;
  /** Calls a tool as `SCOPE_A`, `echo` unless said, and returns the result of the call. */
  readonly call: (
    overrides?: Partial<McpToolCall>,
    deadline?: Duration.Duration,
  ) => ReturnType<typeof runCall>;
}

const runCall = (rig: Rig, input: McpToolCall, deadline?: Duration.Duration) =>
  Effect.runPromise(
    Effect.result(
      rig.controller.harness.mcpServerCalls
        .callTool(input)
        .pipe(
          deadline === undefined
            ? (effect) => effect
            : Effect.provideService(McpCallDeadline, deadline),
        ),
    ),
  );

/**
 * Starts the rig, creates the server and waits until it is `ready`. The fake
 * speaks the newest revision unless `legacy` is set: then it speaks `2025-11-25`,
 * whose upstream MCP sessions have an id a test can look at.
 */
const withReadyServer = (
  body: (rig: ReadyRig) => Promise<void>,
  options: RigOptions & { readonly legacy?: boolean } = {},
) =>
  withRig(
    async (rig) => {
      const connectionId = await rig.connect();
      const server = await createServer(rig.controller, { connectionId });
      expect((await waitForResult(rig.controller)).status).toBe("ready");
      await body({
        ...rig,
        serverId: server.id,
        connectionId,
        call: (overrides = {}, deadline) =>
          runCall(
            rig,
            {
              upstreamScope: SCOPE_A,
              serverId: server.id,
              tool: "echo",
              arguments: { text: "hi" },
              authorize: Effect.void,
              ...overrides,
            },
            deadline,
          ),
      });
    },
    {
      ...options,
      fake: {
        tools: TOOLS,
        ...(options.legacy === true ? { protocols: [McpProtocol.v2025_11_25] } : {}),
        ...options.fake,
      },
    },
  );

/** Returns the requests of one JSON-RPC method the fake received, in order. */
const requestsOf = (fake: FakeUpstream, method: string) =>
  fake.requests.filter((request) => request.method === method);

/** Returns the text of the first block of a tool result. */
const textOf = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}): string | undefined => result.content[0]?.text;

describe("which servers the gateway may serve", () => {
  it("returns the servers that exist, in the order asked, and says which are servable", async () => {
    await withReadyServer(async ({ controller, serverId }) => {
      const { mcpServerCalls } = controller.harness;
      const missing = "0199e0e7-0000-7000-8000-0000000000aa";

      const served = await Effect.runPromise(
        mcpServerCalls.readServedServers([missing, serverId, missing]),
      );

      expect(served).toHaveLength(1);
      expect(served[0]).toMatchObject({
        servable: true,
        server: { id: serverId, status: "ready", enabled: true },
      });
      expect(served[0]?.server.tools.map((tool) => tool.name)).toEqual(
        TOOLS.map((tool) => tool.name),
      );
    });
  });

  it.each([
    ["the server is switched off", "UPDATE mcp_servers SET enabled = 0"],
    ["it has no stored tool list", "UPDATE mcp_servers SET checked_at = NULL"],
    ["its Connection is switched off", "UPDATE connections SET status = 'disabled'"],
  ])("does not mark a server servable when %s", async (_name, statement) => {
    await withReadyServer(async ({ controller, serverId }) => {
      await runSql(controller, controller.harness.sql.unsafe(statement));

      const served = await Effect.runPromise(
        controller.harness.mcpServerCalls.readServedServers([serverId]),
      );

      expect(served.map((one) => one.servable)).toEqual([false]);
    });
  });

  it("still marks a server servable when its Connection needs signing in, and refuses its calls", async () => {
    await withReadyServer(async ({ controller, serverId, call, fake }) => {
      await runSql(
        controller,
        controller.harness.sql`UPDATE connections SET status = 'needs-reauth'`,
      );
      await runSql(
        controller,
        controller.harness.sql`UPDATE mcp_servers SET status = 'needs-sign-in'`,
      );
      const before = fake.requests.length;

      const served = await Effect.runPromise(
        controller.harness.mcpServerCalls.readServedServers([serverId]),
      );
      const result = await call();

      expect(served.map((one) => one.servable)).toEqual([true]);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "needs-sign-in" },
      });
      expect(fake.requests).toHaveLength(before);
    });
  });
});

describe("a refused call", () => {
  it.each(["checking", "needs-sign-in", "unreachable", "error"] as const)(
    "is refused with the status %s as the reason, without contacting the server",
    async (status) => {
      await withReadyServer(async ({ controller, fake, call }) => {
        await runSql(controller, controller.harness.sql`UPDATE mcp_servers SET status = ${status}`);
        const before = fake.requests.length;

        const result = await call();

        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: status } });
        expect(fake.requests).toHaveLength(before);
      });
    },
  );

  it("is refused as switched off for a server that is switched off", async () => {
    await withReadyServer(async ({ controller, serverId, fake, call }) => {
      expect((await requestUpdate(controller, serverId, { enabled: false })).status).toBe(200);
      const before = fake.requests.length;

      const result = await call();

      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "switched-off" } });
      expect(fake.requests).toHaveLength(before);
    });
  });

  it("is refused for a tool the server does not list, and for a server that does not exist", async () => {
    await withReadyServer(async ({ fake, call }) => {
      const before = fake.requests.length;

      const unknownTool = await call({ tool: "nope" });
      const unknownServer = await call({ serverId: "0199e0e7-0000-7000-8000-0000000000aa" });

      expect(unknownTool).toMatchObject({
        _tag: "Failure",
        failure: { reason: "error", message: "The server does not list this tool." },
      });
      expect(unknownServer).toMatchObject({ _tag: "Failure", failure: { reason: "error" } });
      expect(fake.requests).toHaveLength(before);
    });
  });

  it("is refused with the refusal of `authorize`, and nothing is sent", async () => {
    await withReadyServer(async ({ fake, call }) => {
      const result = await call({
        authorize: Effect.fail(
          new McpCallRefused({ reason: "not-in-list", message: "not in the list" }),
        ),
      });

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "not-in-list", message: "not in the list" },
      });
      expect(requestsOf(fake, "tools/call")).toHaveLength(0);
    });
  });
});

describe("a call", () => {
  it("sends the tool's original name and arguments, with the Connection's credential, and returns the answer", async () => {
    await withReadyServer(async ({ fake, call }) => {
      const result = await call({ arguments: { text: "hello" } });

      expect(result).toMatchObject({ _tag: "Success" });
      if (result._tag !== "Success") return;
      expect(textOf(result.success)).toBe(JSON.stringify({ text: "hello" }));
      expect(result.success.isError).toBeUndefined();
      const sent = requestsOf(fake, "tools/call");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ tool: "echo", authorization: "Bearer t0ken", status: 200 });
    });
  });

  it("returns a tool's own error as it came, and changes no status", async () => {
    await withReadyServer(async ({ controller, call }) => {
      const result = await call({ tool: "fail" });

      expect(result).toMatchObject({
        _tag: "Success",
        success: { isError: true },
      });
      if (result._tag !== "Success") return;
      expect(textOf(result.success)).toBe("the tool failed on its own");
      expect((await readRow(controller)).status).toBe("ready");
      expect(await countNotifications(controller)).toBe(0);
    });
  });

  it("returns a JSON-RPC error of the tool as an answer with isError, and changes no status", async () => {
    await withReadyServer(async ({ controller, call }) => {
      const result = await call({ tool: "bad" });

      expect(result).toMatchObject({ _tag: "Success", success: { isError: true } });
      expect((await readRow(controller)).status).toBe("ready");
      expect(await countNotifications(controller)).toBe(0);
    });
  });

  it("returns a 403 as an answer with a fixed text, and changes no status", async () => {
    await withReadyServer(async ({ controller, fake, call }) => {
      fake.intercept = ({ method }) =>
        method === "tools/call" ? new Response("the server's words", { status: 403 }) : undefined;

      const result = await call();

      expect(result).toMatchObject({ _tag: "Success", success: { isError: true } });
      if (result._tag !== "Success") return;
      expect(textOf(result.success)).toBe("the server refused this call (HTTP 403)");
      expect((await readRow(controller)).status).toBe("ready");
      expect(await countNotifications(controller)).toBe(0);
    });
  });

  it("refuses an answer over the size cap as an error, and changes no status", async () => {
    await withReadyServer(async ({ controller, call }) => {
      const result = await call({ tool: "big" });

      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "error" } });
      if (result._tag !== "Failure") return;
      expect(result.failure.message).toContain("the answer was larger than 4 MiB");
      expect((await readRow(controller)).status).toBe("ready");
    });
  });

  it("is refused as timed out when the whole call takes longer than its deadline, and changes no status", async () => {
    await withReadyServer(async ({ controller, fake, call }) => {
      const release = fake.hold("tools/call");

      const result = await call({}, Duration.millis(300));
      release();

      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "timed-out" } });
      expect((await readRow(controller)).status).toBe("ready");
    });
  });

  it.each([
    ["no answer (HTTP 503)", 503, "unreachable", "The server answered with HTTP status 503"],
    [
      "an HTTP status that is no MCP answer (400)",
      400,
      "error",
      "The server answered with HTTP status 400",
    ],
  ] as const)(
    "writes the status of the server when it gives %s",
    async (_name, httpStatus, status, detail) => {
      await withReadyServer(async ({ controller, fake, call }) => {
        fake.intercept = ({ method }) =>
          method === "tools/call" ? new Response(null, { status: httpStatus }) : undefined;

        const result = await call();

        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: status } });
        const row = await eventually(
          () => readRow(controller),
          (found) => found.status === status,
        );
        expect(row.status_detail).toBe(detail);
        if (status === "unreachable") expect(row.failed_checks).toBe(1);
        expect(await countNotifications(controller)).toBe(1);
      });
    },
  );

  it("writes unreachable, and refuses the call as unreachable, when the connection to the server fails", async () => {
    await withReadyServer(async ({ controller, fake, call }) => {
      await fake.stop();

      const result = await call();

      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "unreachable" } });
      const row = await eventually(
        () => readRow(controller),
        (found) => found.status === "unreachable",
      );
      expect(row.status_detail).toBe("The server could not be reached");
    });
  });

  it("cancels the request to the server when the call is interrupted", async () => {
    await withReadyServer(
      async ({ controller, fake, serverId }) => {
        const release = fake.hold("tools/call");
        const fiber = Effect.runFork(
          controller.harness.mcpServerCalls.callTool({
            upstreamScope: SCOPE_A,
            serverId,
            tool: "echo",
            arguments: undefined,
            authorize: Effect.void,
          }),
        );
        await eventually(
          () => Promise.resolve(requestsOf(fake, "tools/call").length),
          (count) => count === 1,
        );

        await Effect.runPromise(Fiber.interrupt(fiber));
        release();

        await eventually(
          () => Promise.resolve(requestsOf(fake, "notifications/cancelled").length),
          (count) => count === 1,
        );
      },
      { legacy: true },
    );
  });

  it("is refused at once while the controller is frozen, and no request leaves", async () => {
    await withReadyServer(async ({ controller, fake, call }) => {
      const { promotion } = controller.harness;
      const tokenId = "0199f0b7-0000-7000-8000-00000000bbbb";
      await Effect.runPromise(promotion.freeze(tokenId, new Date(Date.now() + 60_000)));
      const before = fake.requests.length;

      const result = await call();
      await Effect.runPromise(promotion.thaw(tokenId));

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { controllerNotServing: true },
      });
      expect(fake.requests).toHaveLength(before);
      expect(await call()).toMatchObject({ _tag: "Success" });
    });
  });
});

describe("upstream MCP sessions", () => {
  it("opens one per Session Token and server, reuses it, and keeps two tokens apart", async () => {
    await withReadyServer(
      async ({ fake, call }) => {
        const before = requestsOf(fake, "initialize").length;

        await call({ upstreamScope: SCOPE_A });
        await call({ upstreamScope: SCOPE_A });
        await call({ upstreamScope: SCOPE_B });

        expect(requestsOf(fake, "initialize")).toHaveLength(before + 2);
        const sessions = requestsOf(fake, "tools/call").map((request) => request.sessionId);
        expect(sessions[0]).not.toBeNull();
        expect(sessions[1]).toBe(sessions[0]);
        expect(sessions[2]).not.toBe(sessions[0]);
      },
      { legacy: true },
    );
  });

  it("lets concurrent first calls share one opening", async () => {
    await withReadyServer(
      async ({ fake, call }) => {
        const before = requestsOf(fake, "initialize").length;

        const results = await Promise.all([call(), call(), call()]);

        expect(results.map((result) => result._tag)).toEqual(["Success", "Success", "Success"]);
        expect(requestsOf(fake, "initialize")).toHaveLength(before + 1);
      },
      { legacy: true },
    );
  });

  it.each([
    ["the server's revision moved", "UPDATE mcp_servers SET revision = revision + 1"],
    [
      "its Connection's credentials were replaced",
      "UPDATE connections SET credentials_generation = credentials_generation + 1",
    ],
  ])("opens a new one, and ends the old one, when %s", async (_name, statement) => {
    await withReadyServer(
      async ({ controller, fake, call }) => {
        await call();
        const first = requestsOf(fake, "tools/call")[0]?.sessionId;
        const opened = requestsOf(fake, "initialize").length;

        await runSql(controller, controller.harness.sql.unsafe(statement));
        await call();

        expect(requestsOf(fake, "initialize")).toHaveLength(opened + 1);
        expect(requestsOf(fake, "tools/call")[1]?.sessionId).not.toBe(first);
        await eventually(
          () => Promise.resolve(fake.requests.filter((request) => request.method === "?")),
          (deletes) => deletes.some((request) => request.sessionId === first),
        );
      },
      { legacy: true },
    );
  });

  it("ends every upstream session of a token, and only its own", async () => {
    await withReadyServer(
      async ({ controller, fake, call }) => {
        await call({ upstreamScope: SCOPE_A });
        await call({ upstreamScope: SCOPE_B });
        const [sessionA, sessionB] = requestsOf(fake, "tools/call").map(
          (request) => request.sessionId,
        );
        const { mcpServerCalls } = controller.harness;
        const endedBefore = fake.requests.filter((request) => request.method === "?").length;

        await Effect.runPromise(mcpServerCalls.closeUpstreamScope(SCOPE_A));
        await Effect.runPromise(mcpServerCalls.closeUpstreamScope(SCOPE_A));

        const ended = fake.requests.filter((request) => request.method === "?").slice(endedBefore);
        expect(ended.map((request) => request.sessionId)).toEqual([sessionA]);
        // The next call of the token opens a new session, and the other token's is untouched.
        const opened = requestsOf(fake, "initialize").length;
        await call({ upstreamScope: SCOPE_A });
        await call({ upstreamScope: SCOPE_B });
        expect(requestsOf(fake, "initialize")).toHaveLength(opened + 1);
        expect(requestsOf(fake, "tools/call")[3]?.sessionId).toBe(sessionB);
      },
      { legacy: true },
    );
  });

  it("sends no DELETE for a session it ends while the controller is frozen", async () => {
    await withReadyServer(
      async ({ controller, fake, call }) => {
        await call();
        const { mcpServerCalls, promotion } = controller.harness;
        const tokenId = "0199f0b7-0000-7000-8000-00000000cccc";
        await Effect.runPromise(promotion.freeze(tokenId, new Date(Date.now() + 60_000)));
        const before = fake.requests.length;

        const closing = Effect.runPromise(mcpServerCalls.closeUpstreamScope(SCOPE_A));
        // A DELETE that waited for the thaw would be sent after it.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await Effect.runPromise(promotion.thaw(tokenId));
        await closing;

        expect(fake.requests).toHaveLength(before);
      },
      { legacy: true },
    );
  });

  it("replaces a session the server expired, and sends the call once more", async () => {
    await withReadyServer(
      async ({ controller, fake, call }) => {
        await call();
        const expired = requestsOf(fake, "tools/call")[0]?.sessionId;
        const opened = requestsOf(fake, "initialize").length;
        fake.intercept = ({ method, sessionId }) =>
          method === "tools/call" && sessionId === expired
            ? new Response(null, { status: 404 })
            : undefined;

        const result = await call({ arguments: { text: "again" } });

        expect(result).toMatchObject({ _tag: "Success" });
        const sent = requestsOf(fake, "tools/call");
        expect(sent.map((request) => request.status)).toEqual([200, 404, 200]);
        expect(sent[2]?.sessionId).not.toBe(expired);
        expect(requestsOf(fake, "initialize")).toHaveLength(opened + 1);
        expect((await readRow(controller)).status).toBe("ready");
      },
      { legacy: true },
    );
  });

  it("lets concurrent calls that all met the expired session share one replacement", async () => {
    await withReadyServer(
      async ({ fake, call }) => {
        await call();
        const expired = requestsOf(fake, "tools/call")[0]?.sessionId;
        const opened = requestsOf(fake, "initialize").length;
        fake.intercept = ({ method, sessionId }) =>
          method === "tools/call" && sessionId === expired
            ? new Response(null, { status: 404 })
            : undefined;

        const results = await Promise.all([call(), call(), call()]);

        expect(results.map((result) => result._tag)).toEqual(["Success", "Success", "Success"]);
        expect(requestsOf(fake, "initialize")).toHaveLength(opened + 1);
      },
      { legacy: true },
    );
  });

  it("replaces an expired session only once per call: the second 404 ends the call as an error", async () => {
    await withReadyServer(
      async ({ controller, fake, call }) => {
        await call();
        fake.intercept = ({ method }) =>
          method === "tools/call" ? new Response(null, { status: 404 }) : undefined;

        const result = await call();

        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "error" } });
        // The first call, the one that was sent, and its single resend.
        expect(requestsOf(fake, "tools/call")).toHaveLength(3);
        expect((await readRow(controller)).status).toBe("error");
      },
      { legacy: true },
    );
  });
});

describe("a 401 to the call's own request", () => {
  /** Makes the fake refuse `tools/call` unless it carries the refreshed token. */
  const refuseStoredToken = (fake: FakeUpstream) => {
    fake.authorize = (authorization, method) =>
      method !== "tools/call" || authorization === "Bearer refreshed-token";
  };

  const countRefreshes = (provider: Rig["provider"]) =>
    provider.tokenRequests.filter((form) => form["grant_type"] === "refresh_token").length;

  it("refreshes the credentials, keeps the upstream session, and sends the call once more", async () => {
    await withReadyServer(
      async ({ controller, fake, provider, connectionId, call }) => {
        provider.answers.token = refreshedToken;
        await call();
        const session = requestsOf(fake, "tools/call")[0]?.sessionId;
        const opened = requestsOf(fake, "initialize").length;
        refuseStoredToken(fake);

        const result = await call({ arguments: { text: "second" } });

        expect(result).toMatchObject({ _tag: "Success" });
        const sent = requestsOf(fake, "tools/call").slice(1);
        expect(sent.map((request) => [request.authorization, request.status])).toEqual([
          ["Bearer stored-token", 401],
          ["Bearer refreshed-token", 200],
        ]);
        expect(sent.map((request) => request.sessionId)).toEqual([session, session]);
        expect(requestsOf(fake, "initialize")).toHaveLength(opened);
        expect(countRefreshes(provider)).toBe(1);
        expect((await readRow(controller)).status).toBe("ready");
        expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
          "connected",
        );
      },
      { oauth: true, legacy: true },
    );
  });

  it("refreshes once for concurrent calls of which only one was refused, and sends only that call again", async () => {
    await withReadyServer(
      async ({ fake, provider, call }) => {
        provider.answers.token = refreshedToken;
        await call();
        const before = requestsOf(fake, "tools/call").length;
        // Only the call with the text "refused", on the stored token, is refused.
        fake.intercept = ({ method, params, authorization }) =>
          method === "tools/call" &&
          authorization === "Bearer stored-token" &&
          (params?.arguments as { text?: string } | undefined)?.text === "refused"
            ? new Response("unauthorized", { status: 401 })
            : undefined;

        const results = await Promise.all([
          call({ arguments: { text: "refused" } }),
          call({ arguments: { text: "fine" } }),
        ]);

        expect(results.map((result) => result._tag)).toEqual(["Success", "Success"]);
        const sent = requestsOf(fake, "tools/call")
          .slice(before)
          .map((request) => [request.authorization, request.status]);
        expect(sent).toHaveLength(3);
        expect(sent).toContainEqual(["Bearer stored-token", 401]);
        expect(sent).toContainEqual(["Bearer refreshed-token", 200]);
        expect(sent).toContainEqual(["Bearer stored-token", 200]);
        expect(countRefreshes(provider)).toBe(1);
      },
      { oauth: true, legacy: true },
    );
  });

  it("also refreshes when the 401 answers the opening of the upstream session", async () => {
    await withReadyServer(
      async ({ fake, provider, call }) => {
        provider.answers.token = refreshedToken;
        fake.authorize = (authorization) => authorization === "Bearer refreshed-token";

        const result = await call({ upstreamScope: SCOPE_B });

        expect(result).toMatchObject({ _tag: "Success" });
        expect(countRefreshes(provider)).toBe(1);
        expect(requestsOf(fake, "tools/call").map((request) => request.status)).toEqual([200]);
      },
      { oauth: true, legacy: true },
    );
  });

  it("is refused as needs-sign-in when the provider refuses the refresh, and the call is not sent again", async () => {
    await withReadyServer(
      async ({ controller, fake, provider, connectionId, call }) => {
        provider.answers.token = () =>
          buildJsonResponse(
            { error: "invalid_grant", error_description: "the provider's words" },
            400,
          );
        refuseStoredToken(fake);

        const result = await call();

        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "needs-sign-in" } });
        expect(requestsOf(fake, "tools/call")).toHaveLength(1);
        expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
          "needs-reauth",
        );
      },
      { oauth: true },
    );
  });

  it("is refused as unreachable for this call only when the provider cannot be reached", async () => {
    await withReadyServer(
      async ({ controller, fake, provider, connectionId, call }) => {
        await provider.stop();
        refuseStoredToken(fake);

        const result = await call();

        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "unreachable" } });
        expect(requestsOf(fake, "tools/call")).toHaveLength(1);
        expect((await readRow(controller)).status).toBe("ready");
        expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
          "connected",
        );
        expect(await countNotifications(controller)).toBe(0);
      },
      { oauth: true },
    );
  });

  it("sets the server to error, and leaves the Connection alone, when there is nothing to refresh", async () => {
    await withReadyServer(async ({ controller, fake, connectionId, call }) => {
      refuseStoredToken(fake);

      const result = await call();

      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "error" } });
      expect(requestsOf(fake, "tools/call")).toHaveLength(1);
      expect(await readRow(controller)).toMatchObject({
        status: "error",
        status_detail: "Desk's MCP server refused the Connection's token",
      });
      expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
        "connected",
      );
      expect(await countNotifications(controller, "core.connection-error")).toBe(0);
    });
  });

  it("sets the server to error when the refreshed credentials are refused too, after one refresh", async () => {
    await withReadyServer(
      async ({ controller, fake, provider, connectionId, call }) => {
        provider.answers.token = refreshedToken;
        fake.authorize = (_authorization, method) => method !== "tools/call";

        const result = await call();

        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "error" } });
        expect(requestsOf(fake, "tools/call")).toHaveLength(2);
        expect(countRefreshes(provider)).toBe(1);
        expect(await readRow(controller)).toMatchObject({
          status: "error",
          status_detail: "Desk's MCP server refused the Connection's token",
        });
        expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
          "connected",
        );
      },
      { oauth: true },
    );
  });

  it("does not refresh for a server that was switched off while the call was on its way", async () => {
    await withReadyServer(
      async ({ controller, serverId, fake, provider, call }) => {
        provider.answers.token = refreshedToken;
        refuseStoredToken(fake);
        const release = fake.hold("tools/call");

        const pending = call();
        await eventually(
          () => Promise.resolve(requestsOf(fake, "tools/call").length),
          (count) => count === 1,
        );
        expect((await requestUpdate(controller, serverId, { enabled: false })).status).toBe(200);
        release();
        const result = await pending;

        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "switched-off" } });
        expect(countRefreshes(provider)).toBe(0);
        expect(requestsOf(fake, "tools/call")).toHaveLength(1);
      },
      { oauth: true },
    );
  });

  it("asks `authorize` again before the second send, and sends nothing more when it refuses", async () => {
    await withReadyServer(
      async ({ fake, provider, call }) => {
        provider.answers.token = refreshedToken;
        refuseStoredToken(fake);
        let asked = 0;
        const authorize = Effect.suspend(() => {
          asked += 1;
          return asked === 1
            ? Effect.void
            : Effect.fail(new McpCallRefused({ reason: "not-in-list", message: "left the list" }));
        });

        const result = await call({ authorize });

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: "not-in-list", message: "left the list" },
        });
        expect(asked).toBe(2);
        expect(requestsOf(fake, "tools/call")).toHaveLength(1);
      },
      { oauth: true },
    );
  });
});
