/**
 * Tests what the MCP Gateway asks of `McpServerCalls` - a call of one tool, and
 * ending a token's upstream sessions - against a
 * real controller and a fake outside MCP server that speaks the protocol for
 * real:
 *
 * - what a refused call says for each reason;
 * - a call is answered, with the original tool name and the arguments;
 * - upstream MCP sessions: one per Session Token and server, shared by
 *   concurrent first calls, replaced when the server or its Connection's
 *   credentials moved, replaced once when the server expired one, and ended
 *   with the token;
 * - a 401 to the call's own request: one refresh, the same upstream session,
 *   one more try, and the outcome for each way the refresh can end;
 * - what changes a server's status and what is only the call's answer;
 * - the deadline, the size cap, and a frozen controller;
 * - the checks before every request that leaves the controller: `authorize`,
 *   the destination, and the freeze, including while a session opens, after
 *   the credentials were read (also when reading them waits for a refresh),
 *   and for a refresh that waited for the Connection's permit while the
 *   controller froze;
 * - a failure of the reply to a request of the server never sends the tool
 *   again;
 * - the credentials and the URL each request carries, and the credentials
 *   removed from what the server answers, in values and in object keys;
 * - closing sessions when a server loses its destination, when the gateway
 *   says a token no longer serves a server, and cancelling an opening nobody
 *   waits for, also while its token lives.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { McpProtocol } from "effect/ai";
import { buildJsonResponse, readConnection } from "../connections/testing";
import { del } from "../http/testing";
import { DRAIN_TIMEOUT } from "../promotion";
import { McpCallRefused, type McpToolCall } from "./calls";
import {
  countNotifications,
  eventually,
  readRow,
  readRunningWork,
  refreshedToken,
  requestUpdate,
  runSql,
  storeOauthTokens,
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
  readonly call: (overrides?: Partial<McpToolCall>) => ReturnType<typeof runCall>;
  /** Calls as the gateway does: admitted by the promotion state, so a freeze waits for the call. */
  readonly callAdmitted: (overrides?: Partial<McpToolCall>) => Promise<unknown>;
  /**
   * Calls as `call` does, with the fake holding its answer to `method`. Once
   * the fake has received that request, the call's clock moves to just before
   * a freeze would give up waiting for the call. The held answer is let go
   * after the call ended.
   */
  readonly callPastDeadline: (
    method: string,
    overrides?: Partial<McpToolCall>,
  ) => ReturnType<typeof runCall>;
}

const runCall = (rig: Rig, input: McpToolCall) =>
  Effect.runPromise(Effect.result(rig.controller.harness.mcpServerCalls.callTool(input)));

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
      const buildCall = (overrides: Partial<McpToolCall> = {}): McpToolCall => ({
        upstreamScope: SCOPE_A,
        serverId: server.id,
        tool: "echo",
        arguments: { text: "hi" },
        authorize: Effect.void,
        ...overrides,
      });
      await body({
        ...rig,
        serverId: server.id,
        connectionId,
        call: (overrides) => runCall(rig, buildCall(overrides)),
        callAdmitted: (overrides) =>
          Effect.runPromise(
            Effect.result(
              rig.controller.harness.promotion.admit(
                rig.controller.harness.mcpServerCalls.callTool(buildCall(overrides)),
              ),
            ),
          ),
        callPastDeadline: async (method, overrides) => {
          const received = requestsOf(rig.fake, method).length;
          const release = rig.fake.hold(method);
          const calling = Effect.runPromise(
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(
                Effect.result(rig.controller.harness.mcpServerCalls.callTool(buildCall(overrides))),
              );
              yield* Effect.promise(() =>
                eventually(
                  () => Promise.resolve(requestsOf(rig.fake, method).length),
                  (count) => count > received,
                ),
              );
              // Shortly before a freeze would give up waiting for the call: the
              // call has ended by then. The client's own 60 second limit on a
              // handshake is the same as the freeze's, so it has not fired.
              yield* TestClock.adjust(Duration.subtract(DRAIN_TIMEOUT, Duration.seconds(5)));
              return yield* Fiber.join(fiber);
            }).pipe(Effect.provide(TestClock.layer())),
          );
          try {
            return await calling;
          } finally {
            release();
          }
        },
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

/** Returns the message of a refused call. */
const failureMessage = (result: Awaited<ReturnType<typeof runCall>>): string | undefined =>
  result._tag === "Failure" ? result.failure.message : undefined;

/** Counts the times the fake provider was asked to refresh a token. */
const countRefreshes = (provider: Rig["provider"]) =>
  provider.tokenRequests.filter((form) => form["grant_type"] === "refresh_token").length;

const sleep = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

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

  it("is refused as needs-sign-in when the server's Connection needs signing in, without contacting the server", async () => {
    await withReadyServer(async ({ controller, fake, call }) => {
      await runSql(
        controller,
        controller.harness.sql`UPDATE connections SET status = 'needs-reauth'`,
      );
      const before = fake.requests.length;

      const result = await call();

      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "needs-sign-in" } });
      expect(fake.requests).toHaveLength(before);
    });
  });

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
        failure: {
          reason: "error",
          message: expect.stringContaining("no longer offers this tool"),
        },
      });
      expect(unknownServer).toMatchObject({ _tag: "Failure", failure: { reason: "error" } });
      expect(fake.requests).toHaveLength(before);
    });
  });

  it("is refused with the refusal of `authorize` before the upstream session is even opened", async () => {
    await withReadyServer(async ({ fake, call }) => {
      const before = fake.requests.length;

      const result = await call({
        authorize: Effect.fail(
          new McpCallRefused({ reason: "not-in-list", message: "not in the list" }),
        ),
      });

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "not-in-list", message: "not in the list" },
      });
      expect(fake.requests).toHaveLength(before);
    });
  });

  it("is refused, and nothing is sent, when `authorize` starts refusing while the Connection's token is refreshed", async () => {
    await withReadyServer(
      async ({ controller, connectionId, fake, provider, call }) => {
        await storeOauthTokens(
          controller,
          connectionId,
          { accessToken: "stored-token", refreshToken: "refresh-1" },
          -1000,
        );
        let letRefreshAnswer: () => void = () => undefined;
        const refreshAnswers = new Promise<void>((resolve) => {
          letRefreshAnswer = resolve;
        });
        provider.answers.token = async () => {
          await refreshAnswers;
          return refreshedToken();
        };
        const before = fake.requests.length;
        let allowed = true;

        const pending = call({
          authorize: Effect.suspend(() =>
            allowed
              ? Effect.void
              : Effect.fail(
                  new McpCallRefused({ reason: "not-in-list", message: "left the list" }),
                ),
          ),
        });
        await eventually(
          () => Promise.resolve(provider.tokenRequests.length),
          (count) => count === 1,
        );
        allowed = false;
        letRefreshAnswer();

        expect(await pending).toMatchObject({
          _tag: "Failure",
          failure: { reason: "not-in-list", message: "left the list" },
        });
        expect(fake.requests).toHaveLength(before);
      },
      { oauth: true },
    );
  });

  it.each([
    [
      "the server is switched off",
      "switched-off",
      ({ controller, serverId }: ReadyRig) =>
        requestUpdate(controller, serverId, { enabled: false }),
    ],
    [
      "the tool is no longer listed",
      "error",
      ({ controller }: ReadyRig) =>
        runSql(controller, controller.harness.sql`UPDATE mcp_servers SET tools = '[]'`),
    ],
  ])(
    "is refused, and the tool is not sent, when %s while the upstream session opens",
    async (_name, reason, change) => {
      await withReadyServer(
        async (rig) => {
          const release = rig.fake.hold("initialize");
          const pending = rig.call();
          await eventually(
            () => Promise.resolve(requestsOf(rig.fake, "initialize").length),
            (count) => count === 1,
          );
          await change(rig);
          release();

          const result = await pending;

          expect(result).toMatchObject({ _tag: "Failure", failure: { reason } });
          expect(requestsOf(rig.fake, "tools/call")).toHaveLength(0);
        },
        { legacy: true },
      );
    },
  );
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

  it.each<
    readonly [
      string,
      (rig: ReadyRig) => Partial<McpToolCall> | Promise<Partial<McpToolCall>>,
      string,
    ]
  >([
    [
      "an answer that asks for more input",
      ({ fake }: ReadyRig) => {
        fake.intercept = ({ method, id }) =>
          method === "tools/call"
            ? Response.json({
                jsonrpc: "2.0",
                id,
                result: { resultType: "input_required", inputRequests: {} },
              })
            : undefined;
        return {};
      },
      "this call needs something Hercule does not support",
    ],
    [
      "an argument that does not fit the header its tool declares",
      async ({ controller }: ReadyRig) => {
        await runSql(
          controller,
          controller.harness.sql`UPDATE mcp_servers SET tools = ${JSON.stringify([
            {
              name: "echo",
              description: "",
              inputSchema: {
                type: "object",
                properties: { region: { type: "string", "x-mcp-header": "Region" } },
              },
            },
          ])}`,
        );
        return { arguments: { region: 5 } };
      },
      "did not fit what the tool declares",
    ],
    [
      "a result that does not decode",
      ({ fake }: ReadyRig) => {
        fake.intercept = ({ method, id }) =>
          method === "tools/call"
            ? Response.json({ jsonrpc: "2.0", id, result: { content: "not a list" } })
            : undefined;
        return {};
      },
      "did not fit what the tool declares",
    ],
    ...[400, 413, 422].map(
      (status) =>
        [
          `HTTP ${String(status)} to the tool's request`,
          ({ fake }: ReadyRig) => {
            fake.intercept = ({ method }) =>
              method === "tools/call" ? new Response(null, { status }) : undefined;
            return {};
          },
          `the server refused this call (HTTP ${String(status)})`,
        ] as const,
    ),
  ])("returns %s as this call's answer, and changes no status", async (_name, prepare, text) => {
    await withReadyServer(async (rig) => {
      const overrides = await prepare(rig);

      const result = await rig.call(overrides);

      expect(result).toMatchObject({ _tag: "Success", success: { isError: true } });
      if (result._tag !== "Success") return;
      expect(textOf(result.success)).toContain(text);
      expect((await readRow(rig.controller)).status).toBe("ready");
      expect(await countNotifications(rig.controller)).toBe(0);
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
    await withReadyServer(async ({ controller, callPastDeadline }) => {
      const result = await callPastDeadline("tools/call");

      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "timed-out" } });
      expect(failureMessage(result)).toContain("the call may have run. Ask the user before");
      expect((await readRow(controller)).status).toBe("ready");
    });
  });

  it.each([
    ["no answer (HTTP 503)", 503, "unreachable", "The server answered with HTTP status 503"],
    [
      "an HTTP status that is no MCP answer (410)",
      410,
      "error",
      "The server answered with HTTP status 410",
    ],
  ] as const)(
    "writes the status of the server when it gives %s",
    async (_name, httpStatus, status, detail) => {
      await withReadyServer(async ({ controller, fake, call }) => {
        fake.intercept = ({ method }) =>
          method === "tools/call" ? new Response(null, { status: httpStatus }) : undefined;

        const result = await call();

        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: status } });
        // The tool's request went out, so an unreachable server may have run it.
        if (status === "unreachable") {
          expect(failureMessage(result)).toContain("the call may have run. Ask the user before");
        }
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
      // Nothing was sent, so trying again is fine.
      expect(failureMessage(result)).toContain("Try again later");
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

describe("a call admitted before a freeze", () => {
  it("sends nothing more once the controller is frozen, even while its session is still opening", async () => {
    await withReadyServer(
      async ({ controller, fake, call }) => {
        const { promotion } = controller.harness;
        const tokenId = "0199f0b7-0000-7000-8000-00000000dddd";
        const release = fake.hold("initialize");
        const pending = call();
        await eventually(
          () => Promise.resolve(requestsOf(fake, "initialize").length),
          (count) => count === 1,
        );
        // The freeze waits for the admitted call, so it ends only after the call does.
        const freezing = Effect.runPromise(
          promotion.freeze(tokenId, new Date(Date.now() + 60_000)),
        );
        await eventually(
          () => Effect.runPromise(promotion.phase),
          (phase) => phase._tag === "Frozen",
        );
        release();

        const result = await pending;
        await freezing;
        await Effect.runPromise(promotion.thaw(tokenId));

        expect(result).toMatchObject({ _tag: "Failure", failure: { controllerNotServing: true } });
        expect(requestsOf(fake, "tools/call")).toHaveLength(0);
      },
      { legacy: true },
    );
  });
});

describe("a refresh that waited for the Connection's permit while the controller froze", () => {
  it("does not call the provider once the controller is frozen, and refuses the call as not serving", async () => {
    await withReadyServer(
      async ({ controller, connectionId, provider, call }) => {
        const { promotion } = controller.harness;
        const tokenId = "0199f0b7-0000-7000-8000-00000000eeee";
        await storeOauthTokens(
          controller,
          connectionId,
          { accessToken: "stored-token", refreshToken: "refresh-1" },
          -1000,
        );
        // The first call takes the refresh permit, and its provider request
        // waits. It fails, so the token stays stale for the call after it.
        let letRefreshAnswer: () => void = () => undefined;
        const refreshAnswers = new Promise<void>((resolve) => {
          letRefreshAnswer = resolve;
        });
        provider.answers.token = async () => {
          await refreshAnswers;
          return buildJsonResponse({}, 500);
        };
        const holder = call({ upstreamScope: SCOPE_B });
        await eventually(
          () => Promise.resolve(provider.tokenRequests.length),
          (count) => count === 1,
        );
        const runningBefore = await readRunningWork(promotion);
        // The second call is admitted, and waits for the permit.
        const waiter = call({ upstreamScope: SCOPE_A });
        await eventually(
          () => readRunningWork(promotion),
          (running) => running > runningBefore,
        );
        const freezing = Effect.runPromise(
          promotion.freeze(tokenId, new Date(Date.now() + 60_000)),
        );
        await eventually(
          () => Effect.runPromise(promotion.phase),
          (phase) => phase._tag === "Frozen",
        );
        letRefreshAnswer();

        const results = await Promise.all([holder, waiter]);
        await freezing;
        await Effect.runPromise(promotion.thaw(tokenId));

        expect(results[0]).toMatchObject({ _tag: "Failure", failure: { reason: "unreachable" } });
        expect(results[1]).toMatchObject({
          _tag: "Failure",
          failure: { controllerNotServing: true },
        });
        expect(provider.tokenRequests).toHaveLength(1);
      },
      { oauth: true },
    );
  });
});

describe("a refresh that waited for the Connection's permit while the caller lost its right to the call", () => {
  const leftTheList = () => new McpCallRefused({ reason: "not-in-list", message: "left the list" });

  /** Makes the provider hold its answer to a refresh, as a failed one, until the returned function is called. */
  const holdRefreshAnswer = (provider: Rig["provider"]) => {
    let letAnswer: () => void = () => undefined;
    const answers = new Promise<void>((resolve) => {
      letAnswer = resolve;
    });
    provider.answers.token = async () => {
      await answers;
      return buildJsonResponse({}, 500);
    };
    return letAnswer;
  };

  it("does not call the provider to refresh a stale token, and refuses the call with the caller's refusal", async () => {
    await withReadyServer(
      async ({ controller, connectionId, provider, call }) => {
        await storeOauthTokens(
          controller,
          connectionId,
          { accessToken: "stored-token", refreshToken: "refresh-1" },
          -1000,
        );
        const letRefreshAnswer = holdRefreshAnswer(provider);
        // The first call takes the permit. Its refresh fails, so the token is
        // still stale when the permit goes to the second call.
        const holder = call({ upstreamScope: SCOPE_B });
        await eventually(
          () => Promise.resolve(provider.tokenRequests.length),
          (count) => count === 1,
        );
        // The caller may make the call at its first check, and not after it.
        let checks = 0;
        const waiter = call({
          upstreamScope: SCOPE_A,
          authorize: Effect.suspend(() => {
            checks += 1;
            return checks === 1 ? Effect.void : Effect.fail(leftTheList());
          }),
        });
        await eventually(
          () => Promise.resolve(checks),
          (count) => count >= 1,
        );
        letRefreshAnswer();

        const results = await Promise.all([holder, waiter]);

        expect(results[0]).toMatchObject({ _tag: "Failure", failure: { reason: "unreachable" } });
        expect(results[1]).toMatchObject({
          _tag: "Failure",
          failure: { reason: "not-in-list", message: "left the list" },
        });
        expect(provider.tokenRequests).toHaveLength(1);
      },
      { oauth: true },
    );
  });

  it("does not call the provider to refresh a token the server rejected, and refuses the call with the caller's refusal", async () => {
    await withReadyServer(
      async ({ fake, provider, call }) => {
        fake.authorize = (authorization, method) =>
          method !== "tools/call" || authorization !== "Bearer stored-token";
        const letRefreshAnswer = holdRefreshAnswer(provider);
        // The first call is rejected, and its refresh takes the permit.
        const holder = call({ upstreamScope: SCOPE_B });
        await eventually(
          () => Promise.resolve(provider.tokenRequests.length),
          (count) => count === 1,
        );
        const rejections = () =>
          requestsOf(fake, "tools/call").filter((request) => request.status === 401).length;
        // Once the second call is rejected too, it waits for the permit, and
        // the caller may no longer make the call.
        const waiter = call({
          upstreamScope: SCOPE_A,
          authorize: Effect.suspend(() =>
            rejections() < 2 ? Effect.void : Effect.fail(leftTheList()),
          ),
        });
        await eventually(
          () => Promise.resolve(rejections()),
          (count) => count >= 2,
        );
        letRefreshAnswer();

        const results = await Promise.all([holder, waiter]);

        expect(results[0]).toMatchObject({ _tag: "Failure", failure: { reason: "unreachable" } });
        expect(results[1]).toMatchObject({
          _tag: "Failure",
          failure: { reason: "not-in-list", message: "left the list" },
        });
        expect(provider.tokenRequests).toHaveLength(1);
      },
      { oauth: true },
    );
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

        await Effect.runPromise(mcpServerCalls.closeUpstreamSessionsExcept(SCOPE_A, new Set()));
        await Effect.runPromise(mcpServerCalls.closeUpstreamSessionsExcept(SCOPE_A, new Set()));

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

  it("ends a session with the credentials stored when the DELETE is sent", async () => {
    await withReadyServer(
      async ({ controller, connectionId, fake, call }) => {
        await call();
        await storeOauthTokens(controller, connectionId, {
          accessToken: "rotated-token",
          refreshToken: "refresh-2",
        });
        const endedBefore = requestsOf(fake, "?").length;

        await Effect.runPromise(
          controller.harness.mcpServerCalls.closeUpstreamSessionsExcept(SCOPE_A, new Set()),
        );

        expect(
          requestsOf(fake, "?")
            .slice(endedBefore)
            .map((request) => request.authorization),
        ).toEqual(["Bearer rotated-token"]);
      },
      { oauth: true, legacy: true },
    );
  });

  it("ends a session with the stored token, and calls no provider, when the token went stale meanwhile", async () => {
    await withReadyServer(
      async ({ controller, connectionId, fake, provider, call }) => {
        provider.answers.token = refreshedToken;
        await call();
        await storeOauthTokens(
          controller,
          connectionId,
          { accessToken: "stale-token", refreshToken: "refresh-1" },
          -1000,
        );
        const endedBefore = requestsOf(fake, "?").length;

        await Effect.runPromise(
          controller.harness.mcpServerCalls.closeUpstreamSessionsExcept(SCOPE_A, new Set()),
        );

        expect(
          requestsOf(fake, "?")
            .slice(endedBefore)
            .map((request) => request.authorization),
        ).toEqual(["Bearer stale-token"]);
        expect(provider.tokenRequests).toHaveLength(0);
      },
      { oauth: true, legacy: true },
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

        const closing = Effect.runPromise(
          mcpServerCalls.closeUpstreamSessionsExcept(SCOPE_A, new Set()),
        );
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

  it("replaces an expired session once per call in all, also when a refresh sends the call again", async () => {
    await withReadyServer(
      async ({ fake, provider, call }) => {
        provider.answers.token = refreshedToken;
        await call();
        const expired = requestsOf(fake, "tools/call")[0]?.sessionId;
        const opened = requestsOf(fake, "initialize").length;
        // The old session expired. The one that replaces it refuses the stored
        // token. After the refresh, that session expires as well.
        fake.intercept = ({ method, sessionId, authorization }) =>
          method !== "tools/call"
            ? undefined
            : sessionId === expired || authorization === "Bearer refreshed-token"
              ? new Response(null, { status: 404 })
              : new Response("unauthorized", { status: 401 });

        const result = await call();

        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "error" } });
        expect(countRefreshes(provider)).toBe(1);
        expect(requestsOf(fake, "initialize")).toHaveLength(opened + 1);
      },
      { oauth: true, legacy: true },
    );
  });

  it("still replaces an expired session once in the next call, after the server refused the reply to a request of its own with 404", async () => {
    await withReadyServer(
      async ({ fake, call }) => {
        fake.intercept = ({ method }) =>
          method === "tools/call"
            ? new Response(
                `data: ${JSON.stringify({ jsonrpc: "2.0", id: "from-server", method: "ping" })}\n\n`,
                { status: 200, headers: { "content-type": "text/event-stream" } },
              )
            : method === "?"
              ? new Response("gone", { status: 404 })
              : undefined;
        const broken = await call();
        expect(broken).toMatchObject({ _tag: "Failure", failure: { reason: "error" } });
        // The next call meets one expired session of its own.
        let refused = false;
        fake.intercept = ({ method }) => {
          if (method !== "tools/call" || refused) return undefined;
          refused = true;
          return new Response(null, { status: 404 });
        };

        const result = await call();

        expect(result).toMatchObject({ _tag: "Success" });
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

  it("asks `authorize` before the refresh and the second send, and refreshes and sends nothing more when it refuses", async () => {
    await withReadyServer(
      async ({ fake, provider, call }) => {
        provider.answers.token = refreshedToken;
        refuseStoredToken(fake);
        // Allowed until the tool has been sent once.
        const authorize = Effect.suspend(() =>
          requestsOf(fake, "tools/call").length === 0
            ? Effect.void
            : Effect.fail(new McpCallRefused({ reason: "not-in-list", message: "left the list" })),
        );

        const result = await call({ authorize });

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: "not-in-list", message: "left the list" },
        });
        expect(requestsOf(fake, "tools/call")).toHaveLength(1);
        expect(countRefreshes(provider)).toBe(0);
      },
      { oauth: true },
    );
  });
});

describe("a reply to a request of the server", () => {
  /** Answers a `tools/call` with a request of the server (a ping) that the client must reply to. */
  const askServerRequest = () =>
    new Response(
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: "from-server", method: "ping" })}\n\n`,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );

  it("carries the credentials stored when it is sent, not those of the tool's request", async () => {
    await withReadyServer(
      async ({ controller, connectionId, fake, call }) => {
        fake.intercept = ({ method }) =>
          method === "tools/call"
            ? askServerRequest()
            : method === "?"
              ? new Response(null, { status: 202 })
              : undefined;
        const repliesBefore = requestsOf(fake, "?").length;
        const release = fake.hold("tools/call");
        const pending = call({});
        await eventually(
          () => Promise.resolve(requestsOf(fake, "tools/call").length),
          (count) => count === 1,
        );
        // A refresh stored a new token while the server was about to ask.
        await storeOauthTokens(controller, connectionId, {
          accessToken: "rotated-token",
          refreshToken: "refresh-2",
        });
        release();
        await pending;

        expect(requestsOf(fake, "tools/call")[0]?.authorization).toBe("Bearer stored-token");
        expect(
          requestsOf(fake, "?")
            .slice(repliesBefore)
            .map((request) => request.authorization),
        ).toEqual(["Bearer rotated-token"]);
      },
      { oauth: true, legacy: true },
    );
  });

  it.each([[false], [true]])(
    "sends the stored token and starts no refresh when the token went stale while the tool ran (controller frozen: %s)",
    async (freezes) => {
      await withReadyServer(
        async ({ controller, connectionId, fake, provider, callAdmitted }) => {
          const { promotion } = controller.harness;
          const tokenId = "0199f0b7-0000-7000-8000-00000000dddd";
          provider.answers.token = refreshedToken;
          fake.intercept = ({ method }) =>
            method === "tools/call"
              ? askServerRequest()
              : method === "?"
                ? new Response(null, { status: 202 })
                : undefined;
          const repliesBefore = requestsOf(fake, "?").length;
          const release = fake.hold("tools/call");
          const pending = callAdmitted();
          await eventually(
            () => Promise.resolve(requestsOf(fake, "tools/call").length),
            (count) => count === 1,
          );
          // The token went stale while the tool ran, and a freeze may wait for the call.
          await storeOauthTokens(
            controller,
            connectionId,
            { accessToken: "stale-token", refreshToken: "refresh-1" },
            -1000,
          );
          const freezing = freezes
            ? Effect.runPromise(promotion.freeze(tokenId, new Date(Date.now() + 60_000)))
            : undefined;
          if (freezing !== undefined) {
            await eventually(
              () => Effect.runPromise(promotion.phase),
              (phase) => phase._tag === "Frozen",
            );
          }
          release();

          await pending;
          await freezing;
          if (freezes) await Effect.runPromise(promotion.thaw(tokenId));

          expect(
            requestsOf(fake, "?")
              .slice(repliesBefore)
              .map((request) => request.authorization),
          ).toEqual(["Bearer stale-token"]);
          expect(provider.tokenRequests).toHaveLength(0);
        },
        { oauth: true, legacy: true },
      );
    },
  );

  it.each([[401], [404]])(
    "that the server refuses with HTTP %i never sends the tool again, refreshes nothing and changes no status",
    async (status) => {
      await withReadyServer(
        async ({ controller, fake, provider, call }) => {
          provider.answers.token = refreshedToken;
          // A reply has no JSON-RPC method, which the fake records as `?`.
          fake.intercept = ({ method }) =>
            method === "tools/call"
              ? askServerRequest()
              : method === "?"
                ? new Response("refused", { status })
                : undefined;

          const result = await call();

          expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "error" } });
          if (result._tag !== "Failure") return;
          expect(result.failure.message).toContain("may have run");
          expect(requestsOf(fake, "tools/call")).toHaveLength(1);
          expect(countRefreshes(provider)).toBe(0);
          expect((await readRow(controller)).status).toBe("ready");
        },
        { oauth: true, legacy: true },
      );
    },
  );
});

describe("what each request carries and what comes back", () => {
  it("sends the URL the plugin builds for the credentials current at that moment", async () => {
    await withReadyServer(
      async ({ fake, provider, call }) => {
        provider.answers.token = refreshedToken;
        await call();
        // The stored token is refused from now on, so the call refreshes it.
        fake.authorize = (authorization, method) =>
          method !== "tools/call" || authorization === "Bearer refreshed-token";

        await call({ arguments: { text: "second" } });

        const sent = requestsOf(fake, "tools/call").slice(1);
        expect(sent.map((request) => [request.url, request.status])).toEqual([
          ["/mcp?key=stored-token", 401],
          ["/mcp?key=refreshed-token", 200],
        ]);
      },
      {
        oauth: true,
        legacy: true,
        buildUpstreamRequest: (credentials, upstream) => ({
          url: `${upstream.url}?key=${credentials["accessToken"] ?? ""}`,
          headers: { Authorization: `Bearer ${credentials["accessToken"] ?? ""}` },
        }),
      },
    );
  });

  it("reads the credentials again for each request of the opening, so the rest of the handshake carries the current ones", async () => {
    await withReadyServer(
      async ({ controller, connectionId, fake, call }) => {
        const opened = requestsOf(fake, "initialize").length;
        const release = fake.hold("initialize");
        const pending = call({ upstreamScope: SCOPE_B });
        await eventually(
          () => Promise.resolve(requestsOf(fake, "initialize").length),
          (count) => count === opened + 1,
        );
        // Another caller refreshed the token while the handshake waited.
        await storeOauthTokens(controller, connectionId, {
          accessToken: "rotated-token",
          refreshToken: "refresh-2",
        });
        release();

        expect(await pending).toMatchObject({ _tag: "Success" });

        const carried = (method: string) => requestsOf(fake, method).at(-1)?.authorization;
        expect(carried("initialize")).toBe("Bearer stored-token");
        expect(carried("notifications/initialized")).toBe("Bearer rotated-token");
        expect(carried("tools/call")).toBe("Bearer rotated-token");
      },
      { oauth: true, legacy: true },
    );
  });

  it("reads the credentials again when a refresh stored new ones while the checks before the request ran", async () => {
    await withReadyServer(
      async ({ controller, connectionId, fake, call }) => {
        // The second check is the one before the opening's first request, after
        // its credentials were read. A refresh stores new tokens during it.
        let checks = 0;
        const authorize = Effect.suspend(() => {
          checks += 1;
          return checks === 2
            ? Effect.promise(() =>
                storeOauthTokens(controller, connectionId, {
                  accessToken: "rotated-token",
                  refreshToken: "refresh-2",
                }),
              )
            : Effect.void;
        });

        const result = await call({ upstreamScope: SCOPE_B, authorize });

        expect(result).toMatchObject({ _tag: "Success" });
        const carried = (method: string) => requestsOf(fake, method).at(-1)?.authorization;
        expect(carried("initialize")).toBe("Bearer rotated-token");
        expect(carried("tools/call")).toBe("Bearer rotated-token");
      },
      { oauth: true, legacy: true },
    );
  });

  it("removes the credentials of the request from a key of the result", async () => {
    await withReadyServer(
      async ({ fake, call }) => {
        fake.intercept = ({ method, id, authorization }) =>
          method === "tools/call"
            ? new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [{ type: "text", text: "ok" }],
                    structuredContent: { [authorization ?? ""]: 1 },
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            : undefined;

        const result = await call();

        expect(result).toMatchObject({
          _tag: "Success",
          success: { structuredContent: { "[removed]": 1 } },
        });
      },
      { oauth: true },
    );
  });

  it.each([
    [
      "a JSON-RPC error",
      (echo: string) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32602, message: `bad arguments, request carried ${echo}` },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
    [
      "an ordinary result",
      (echo: string, id: unknown) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `you sent ${echo}` }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
  ])(
    "removes the credentials of the request from %s the server sends back",
    async (_name, buildAnswer) => {
      await withReadyServer(
        async ({ fake, call }) => {
          fake.intercept = ({ method, id, authorization }) =>
            method === "tools/call" ? buildAnswer(authorization ?? "", id) : undefined;

          const result = await call();

          const text = result._tag === "Success" ? textOf(result.success) : result.failure.message;
          expect(text).not.toContain("stored-token");
          expect(text).toContain("[removed]");
        },
        { oauth: true },
      );
    },
  );
});

describe("what is removed from an answer", () => {
  const answerWith = (text: string, id: unknown) =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("includes a credential the handshake of the upstream session carried and a refresh replaced", async () => {
    await withReadyServer(
      async ({ controller, connectionId, fake, call }) => {
        fake.intercept = ({ method, id }) =>
          method === "tools/call"
            ? answerWith("the handshake carried stored-token", id)
            : undefined;
        const opened = requestsOf(fake, "initialize").length;
        const release = fake.hold("initialize");
        const pending = call({ upstreamScope: SCOPE_B });
        await eventually(
          () => Promise.resolve(requestsOf(fake, "initialize").length),
          (count) => count === opened + 1,
        );
        // Another caller refreshed the token while the handshake waited, so
        // the call itself sends only the new one.
        await storeOauthTokens(controller, connectionId, {
          accessToken: "rotated-token",
          refreshToken: "refresh-2",
        });
        release();

        const result = await pending;

        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        expect(textOf(result.success)).toBe("the handshake carried [removed]");
      },
      { oauth: true, legacy: true },
    );
  });

  it("includes a credential an earlier attempt of the call sent on another upstream session", async () => {
    await withReadyServer(
      async ({ controller, connectionId, fake, call }) => {
        await call();
        const expired = requestsOf(fake, "tools/call")[0]?.sessionId;
        fake.intercept = ({ method, id, sessionId }) =>
          method !== "tools/call"
            ? undefined
            : sessionId === expired
              ? new Response(null, { status: 404 })
              : answerWith("the first attempt carried stored-token", id);
        // The first attempt is refused with a 404, and a refresh stores a new
        // token before the second attempt opens its own session.
        let rotated = false;
        const authorize = Effect.suspend(() =>
          rotated || !requestsOf(fake, "tools/call").some((request) => request.status === 404)
            ? Effect.void
            : Effect.promise(async () => {
                rotated = true;
                await storeOauthTokens(controller, connectionId, {
                  accessToken: "rotated-token",
                  refreshToken: "refresh-2",
                });
              }),
        );

        const result = await call({ authorize });

        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        expect(requestsOf(fake, "tools/call").at(-1)?.authorization).toBe("Bearer rotated-token");
        expect(textOf(result.success)).toBe("the first attempt carried [removed]");
      },
      { oauth: true, legacy: true },
    );
  });
});

describe("what is removed from an answer after a session was replaced", () => {
  const answerWith = (text: string, id: unknown) =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("includes a credential only the handshake of an expired session carried", async () => {
    await withReadyServer(
      async ({ controller, connectionId, fake, call }) => {
        // The handshake of the first session carries the stored token.
        await call();
        const expired = requestsOf(fake, "tools/call")[0]?.sessionId;
        await storeOauthTokens(controller, connectionId, {
          accessToken: "rotated-token",
          refreshToken: "refresh-2",
        });
        fake.intercept = ({ method, id, sessionId }) =>
          method !== "tools/call"
            ? undefined
            : sessionId === expired
              ? new Response(null, { status: 404 })
              : answerWith("the old handshake carried stored-token", id);

        const result = await call();

        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        expect(textOf(result.success)).toBe("the old handshake carried [removed]");
      },
      { oauth: true, legacy: true },
    );
  });

  it("includes a credential only the failed opening of an upstream session carried", async () => {
    await withReadyServer(
      async ({ fake, provider, call }) => {
        provider.answers.token = refreshedToken;
        fake.authorize = (authorization) => authorization === "Bearer refreshed-token";
        fake.intercept = ({ method, id }) =>
          method === "tools/call" ? answerWith("the opening carried stored-token", id) : undefined;

        const result = await call({ upstreamScope: SCOPE_B });

        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        expect(textOf(result.success)).toBe("the opening carried [removed]");
      },
      { oauth: true, legacy: true },
    );
  });
});

describe("closing upstream MCP sessions", () => {
  /** The `Mcp-Session-Id` of every DELETE the fake received. */
  const endedSessions = (fake: FakeUpstream) =>
    fake.requests.filter((request) => request.method === "?").map((request) => request.sessionId);

  it.each([
    [
      "switched off",
      ({ controller, serverId }: ReadyRig) =>
        requestUpdate(controller, serverId, { enabled: false }),
    ],
    [
      "deleted",
      ({ controller, serverId }: ReadyRig) =>
        del(controller.base, `/api/v1/mcp-servers/${serverId}`, controller.token),
    ],
  ])("closes the sessions of a server that is %s", async (_name, change) => {
    await withReadyServer(
      async (rig) => {
        await rig.call();
        const session = requestsOf(rig.fake, "tools/call")[0]?.sessionId;
        expect(session).not.toBeNull();

        expect((await change(rig)).status).toBe(200);

        await eventually(
          () => Promise.resolve(endedSessions(rig.fake)),
          (ended) => ended.includes(session ?? null),
        );
      },
      { legacy: true },
    );
  });

  it("closes the sessions of the servers a token is no longer served, and no other", async () => {
    await withReadyServer(
      async ({ controller, serverId, fake, call }) => {
        await call({ upstreamScope: SCOPE_A });
        await call({ upstreamScope: SCOPE_B });
        const [sessionA, sessionB] = requestsOf(fake, "tools/call").map(
          (request) => request.sessionId,
        );
        const endedBefore = endedSessions(fake).length;
        const { mcpServerCalls } = controller.harness;

        await Effect.runPromise(
          mcpServerCalls.closeUpstreamSessionsExcept(SCOPE_A, new Set([serverId])),
        );
        expect(endedSessions(fake)).toHaveLength(endedBefore);

        await Effect.runPromise(mcpServerCalls.closeUpstreamSessionsExcept(SCOPE_A, new Set()));
        expect(endedSessions(fake).slice(endedBefore)).toEqual([sessionA]);
        const opened = requestsOf(fake, "initialize").length;
        await call({ upstreamScope: SCOPE_A });
        await call({ upstreamScope: SCOPE_B });
        expect(requestsOf(fake, "initialize")).toHaveLength(opened + 1);
        expect(requestsOf(fake, "tools/call")[3]?.sessionId).toBe(sessionB);
      },
      { legacy: true },
    );
  });

  it("cancels an opening that no call waits for any more, while its token lives", async () => {
    await withReadyServer(
      async ({ fake, call, callPastDeadline }) => {
        const before = {
          initialize: requestsOf(fake, "initialize").length,
          initialized: requestsOf(fake, "notifications/initialized").length,
          ended: endedSessions(fake).length,
        };
        const abandoned = await callPastDeadline("initialize");
        expect(abandoned).toMatchObject({ _tag: "Failure", failure: { reason: "timed-out" } });
        // The tool was never sent, so trying again is fine.
        expect(failureMessage(abandoned)).toBe("The call took too long. Try again later.");

        // A cancelled opening never goes on to send what follows the handshake.
        await sleep(300);

        expect(requestsOf(fake, "initialize")).toHaveLength(before.initialize + 1);
        expect(requestsOf(fake, "notifications/initialized")).toHaveLength(before.initialized);
        expect(endedSessions(fake)).toHaveLength(before.ended);
        // The abandoned opening is not reused: the next call opens its own session.
        expect(await call()).toMatchObject({ _tag: "Success" });
        expect(requestsOf(fake, "initialize")).toHaveLength(before.initialize + 2);
      },
      { legacy: true },
    );
  });
});
