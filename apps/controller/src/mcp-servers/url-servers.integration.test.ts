/**
 * Tests how a server added by URL is reached, against a real controller and a
 * fake outside MCP server that speaks the protocol for real. The tests write
 * the server's rows themselves, so that they can give it any state:
 *
 * - a check lists the tools with no sign-in and with a pasted token, and an
 *   HTTP 401 makes the server `needs-sign-in` and records which sign-in the
 *   server offers;
 * - a call goes through the server's calls end to end, and is refused in the
 *   words of a server added by URL;
 * - a sign-in that was replaced is never read for a request that only
 *   continues an exchange, and an upstream session lives as long as the
 *   sign-in it was opened with;
 * - the token the server echoes is removed from tools, results and errors;
 * - a tool list is bounded while it is read, for every kind of server;
 * - the follower leaves a server added by URL alone.
 */
import { describe, expect, it } from "vitest";
import { Effect, Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Fiber from "effect/Fiber";
import { McpProtocol } from "effect/ai";
import { Secrets } from "../secrets";
import {
  collectPushes,
  fetchTicket,
  onSocket,
  send,
  waitForLiveToSettle,
  waitWithin,
} from "../http/testing";
import type { SetUpController } from "../workflows/testing";
import { resolveServerAccess, ServerCredentialsUnavailable } from "./access";
import { McpCallRefused, type McpToolCall } from "./calls";
import { mcpServerSignIns } from "./sign-ins";
import {
  eventually,
  buildMcpServerView,
  readRow,
  requestCheck,
  requestUpdate,
  runSql,
  waitForResult,
  withRig,
  withUrlRig,
  insertUrlServerAt,
  createServer,
  type FakeUpstream,
  type McpServerRow,
} from "./testing";

const SCOPE = "scope-url";

const callAs = (
  controller: SetUpController,
  serverId: string,
  overrides: Partial<McpToolCall> = {},
) =>
  Effect.runPromise(
    Effect.result(
      controller.harness.mcpServerCalls.callTool({
        upstreamScope: SCOPE,
        serverId,
        tool: "echo",
        arguments: { text: "hi" },
        authorize: Effect.void,
        ...overrides,
      }),
    ),
  );

const requestsOf = (fake: FakeUpstream, method: string) =>
  fake.requests.filter((request) => request.method === method);

const sleep = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

/** Waits until the stored status is `status`, and returns the row. */
const waitForStatus = (controller: SetUpController, status: string): Promise<McpServerRow> =>
  eventually(
    () => readRow(controller),
    (row) => row.status === status,
  );

/** Answers a page of `tools/list` with these tools. */
const buildListPage = (
  id: unknown,
  tools: ReadonlyArray<{ readonly name: string; readonly description: string }>,
  nextCursor?: string,
) =>
  Response.json({
    jsonrpc: "2.0",
    id,
    result: {
      // The newest revision requires every list result to say how long it may be cached.
      ttlMs: 0,
      cacheScope: "private",
      tools: tools.map((tool) => ({ ...tool, inputSchema: { type: "object" } })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  });

/** Reads the sign-ins the way the controller does, over the controller's own database. */
const readSignIns = (controller: SetUpController) =>
  Effect.runPromise(
    mcpServerSignIns.pipe(
      Effect.provideService(Secrets, controller.harness.secrets),
      Effect.provideService(SqlClient.SqlClient, controller.harness.sql),
    ),
  );

/** Replaces the server's token and raises its revision, as signing in again does. */
const replaceToken = (controller: SetUpController, serverId: string, token: string) =>
  runSql(
    controller,
    Effect.gen(function* () {
      yield* controller.harness.secrets.set(
        { kind: "mcp-server", id: serverId },
        "token",
        Redacted.make(token),
      );
      yield* controller.harness.sql`UPDATE mcp_servers SET revision = revision + 1`;
    }),
  );

/** Gives the server a token through the public `setToken` operation, which raises its revision. */
const setTokenThroughApi = async (controller: SetUpController, serverId: string, token: string) => {
  const response = await send("POST", controller.base, `/api/v1/mcp-servers/${serverId}/token`, {
    body: { token },
    token: controller.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

describe("the check of a server added by URL", () => {
  it("lists the tools with no sign-in, sending no Authorization header", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      await insertUrlServer();

      const row = await waitForResult(controller);

      expect(row).toMatchObject({ status: "ready", status_detail: null, sign_in_offered: null });
      expect(JSON.parse(row.tools)).toMatchObject([{ name: "echo" }]);
      expect(new Set(fake.requests.map((request) => request.authorization))).toEqual(
        new Set([null]),
      );
    });
  });

  it("lists the tools with a pasted token, sending it as a bearer token", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      fake.authorize = (authorization) => authorization === "Bearer t0ken";
      await insertUrlServer({ token: "t0ken" });

      const row = await waitForResult(controller);

      expect(row.status).toBe("ready");
      expect(new Set(fake.requests.map((request) => request.authorization))).toEqual(
        new Set(["Bearer t0ken"]),
      );
    });
  });

  it.each([
    ["a bare challenge", "Bearer", "token"],
    [
      "a challenge that names its OAuth metadata",
      `Bearer realm="mcp", resource_metadata="https://auth.example/.well-known/oauth-protected-resource"`,
      "oauth",
    ],
    [
      "a challenge that only mentions the parameter inside a quoted value",
      `Bearer error_description="resource_metadata=x"`,
      "token",
    ],
    [
      "a Basic challenge that carries the parameter",
      `Basic realm="mcp", resource_metadata="https://auth.example/meta"`,
      "token",
    ],
    [
      "a Basic challenge and a Bearer challenge that names its OAuth metadata",
      `Basic realm="mcp", Bearer error="invalid_token", resource_metadata="https://auth.example/meta"`,
      "oauth",
    ],
  ] as const)(
    "needs sign-in after an HTTP 401 with %s, and records that the server offers %s",
    async (_name, challenge, offered) => {
      await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
        fake.authorize = () => false;
        fake.challenge = challenge;
        await insertUrlServer();

        const row = await waitForResult(controller);

        expect(row).toMatchObject({
          status: "needs-sign-in",
          status_detail:
            "remote asks for sign-in: paste a token or sign in in Settings > MCP servers",
          status_cause: null,
          sign_in_offered: offered,
        });
      });
    },
  );

  it("says the token was refused when the server held one, keeps the last tools, and leaves what the server offered as it is after a success", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer({ token: "t0ken" });
      const first = await waitForResult(controller);
      expect(first.status).toBe("ready");

      fake.authorize = () => false;
      fake.challenge = `Bearer resource_metadata="https://auth.example/meta"`;
      expect((await requestCheck(controller, serverId)).status).toBe(200);
      const refused = await waitForStatus(controller, "needs-sign-in");

      expect(refused).toMatchObject({
        status_detail:
          "remote refused its sign-in: paste a token or sign in in Settings > MCP servers",
        sign_in_offered: "oauth",
        tools: first.tools,
      });

      fake.authorize = () => true;
      expect((await requestCheck(controller, serverId)).status).toBe(200);
      const recovered = await waitForStatus(controller, "ready");

      expect(recovered.sign_in_offered).toBe("oauth");
    });
  });
});

describe("a call to a server added by URL", () => {
  it("is answered, with the token as a bearer token", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer({ token: "t0ken" });
      await waitForResult(controller);

      const result = await callAs(controller, serverId, { arguments: { text: "hello" } });

      expect(result).toMatchObject({ _tag: "Success" });
      if (result._tag !== "Success") return;
      expect(result.success.content[0]).toMatchObject({
        type: "text",
        text: JSON.stringify({ text: "hello" }),
      });
      expect(requestsOf(fake, "tools/call")).toMatchObject([
        { tool: "echo", authorization: "Bearer t0ken", status: 200 },
      ]);
    });
  });

  it("is answered with no Authorization header when the server holds no token", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer();
      await waitForResult(controller);

      const result = await callAs(controller, serverId);

      expect(result._tag).toBe("Success");
      expect(requestsOf(fake, "tools/call")[0]?.authorization).toBeNull();
    });
  });

  it("is refused in the words of a server added by URL when the server needs sign-in, without contacting it", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      fake.authorize = () => false;
      const serverId = await insertUrlServer();
      await waitForStatus(controller, "needs-sign-in");
      const before = fake.requests.length;

      const result = await callAs(controller, serverId);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "needs-sign-in",
          message:
            "remote needs sign-in. Ask the user to paste a token or sign in in Settings > MCP servers.",
        },
      });
      expect(fake.requests).toHaveLength(before);
    });
  });

  it("makes the server need sign-in, in the same words, when the server refuses the token of a call", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer({ token: "t0ken" });
      await waitForResult(controller);
      fake.authorize = () => false;

      const result = await callAs(controller, serverId);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "needs-sign-in",
          message:
            "remote needs sign-in. Ask the user to paste a token or sign in in Settings > MCP servers.",
        },
      });
      expect(result._tag === "Failure" && result.failure).toBeInstanceOf(McpCallRefused);
      expect((await readRow(controller)).status).toBe("needs-sign-in");
    });
  });
});

describe("a call that the server refuses with HTTP 401", () => {
  it("records what the server offers, the way a check does", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer({ token: "t0ken-1234" });
      await waitForResult(controller);
      fake.authorize = () => false;
      fake.challenge = `Bearer resource_metadata="https://auth.example/meta"`;

      expect((await callAs(controller, serverId))._tag).toBe("Failure");

      expect(await readRow(controller)).toMatchObject({
        status: "needs-sign-in",
        sign_in_offered: "oauth",
      });
    });
  });

  it("leaves the same stored state as a check that gets the same 401", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer({ token: "t0ken-1234" });
      await waitForResult(controller);
      fake.authorize = () => false;
      fake.challenge = `Bearer resource_metadata="https://auth.example/meta"`;
      const readFailure = async () => {
        const { status, status_detail, status_cause, sign_in_offered, failed_checks } =
          await waitForStatus(controller, "needs-sign-in");
        return { status, status_detail, status_cause, sign_in_offered, failed_checks };
      };

      expect((await callAs(controller, serverId))._tag).toBe("Failure");
      const afterCall = await readFailure();
      await runSql(
        controller,
        controller.harness
          .sql`UPDATE mcp_servers SET status = 'ready', status_detail = NULL, sign_in_offered = NULL`,
      );
      expect((await requestCheck(controller, serverId)).status).toBe(200);
      const afterCheck = await readFailure();

      expect(afterCheck).toEqual(afterCall);
      expect(afterCall.sign_in_offered).toBe("oauth");
    });
  });

  it("records a plain token as the offer when the challenge names no OAuth metadata", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer({ token: "t0ken-1234" });
      await waitForResult(controller);
      fake.authorize = () => false;
      fake.challenge = `Basic realm="mcp", resource_metadata="https://auth.example/meta"`;

      expect((await callAs(controller, serverId))._tag).toBe("Failure");

      expect((await readRow(controller)).sign_in_offered).toBe("token");
    });
  });

  it("announces a change of the offered sign-in alone, with the status unchanged, on the live topic", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      fake.authorize = () => false;
      const serverId = await insertUrlServer();
      const refused = await waitForStatus(controller, "needs-sign-in");
      expect(refused.sign_in_offered).toBe("token");
      const ticket = await fetchTicket(controller.base, controller.token);

      await onSocket(controller.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const pushes = yield* collectPushes(client, "mcpServer");
          yield* Effect.promise(async () => {
            await waitForLiveToSettle();
            const announced = pushes.received.length;
            fake.challenge = `Bearer resource_metadata="https://auth.example/meta"`;

            expect((await requestCheck(controller, serverId)).status).toBe(200);
            const offered = await eventually(
              () => readRow(controller),
              (row) => row.sign_in_offered === "oauth",
            );

            expect(offered.status).toBe("needs-sign-in");
            expect(await waitWithin(2000, () => pushes.received.length > announced)).toBe(true);
            expect(pushes.received.at(-1)).toEqual({
              _tag: "invalidate",
              ids: [serverId],
              kind: "updated",
            });
          });
          yield* Fiber.interrupt(pushes.fiber);
        }),
      );
    });
  });
});

describe("the sign-in a request carries", () => {
  it("sends no DELETE to end an upstream session whose token was replaced, so the new token never goes with it", async () => {
    await withUrlRig(
      async ({ controller, fake, insertUrlServer }) => {
        const serverId = await insertUrlServer({ token: "old-token" });
        await waitForResult(controller);
        expect((await callAs(controller, serverId))._tag).toBe("Success");
        const endsBefore = requestsOf(fake, "?").length;

        await replaceToken(controller, serverId, "new-token");
        await Effect.runPromise(
          controller.harness.mcpServerCalls.closeUpstreamSessionsExcept(SCOPE, new Set()),
        );

        // The session ends on its own at the server in time. What matters is
        // that the request that ends it is not sent with the token that
        // replaced the old one.
        expect(requestsOf(fake, "?")).toHaveLength(endsBefore);
        expect(fake.requests.map((request) => request.authorization)).not.toContain(
          "Bearer new-token",
        );
      },
      { fake: { protocols: [McpProtocol.v2025_11_25] } },
    );
  });

  it("ends the upstream session with its own token while the sign-in is unchanged", async () => {
    await withUrlRig(
      async ({ controller, fake, insertUrlServer }) => {
        const serverId = await insertUrlServer({ token: "old-token" });
        await waitForResult(controller);
        expect((await callAs(controller, serverId))._tag).toBe("Success");
        const endsBefore = requestsOf(fake, "?").length;

        await Effect.runPromise(
          controller.harness.mcpServerCalls.closeUpstreamSessionsExcept(SCOPE, new Set()),
        );

        const ends = requestsOf(fake, "?");
        expect(ends).toHaveLength(endsBefore + 1);
        expect(ends.at(-1)?.authorization).toBe("Bearer old-token");
      },
      { fake: { protocols: [McpProtocol.v2025_11_25] } },
    );
  });

  it("has a read for a request that continues an exchange that refuses it once the token is another than the session opened with, and gives the new token to a session that opens after", async () => {
    await withUrlRig(async ({ controller, insertUrlServer }) => {
      const serverId = await insertUrlServer({ token: "old-token" });
      const signIns = await readSignIns(controller);
      const view = buildMcpServerView({ url: { signIn: "token" } });
      const access = resolveServerAccess(
        { ...view, server: { ...view.server, id: serverId } },
        {} as never,
        signIns,
      );
      if (access._tag !== "usable") throw new Error("a server added by URL is always usable");
      const { credentials } = access;
      const openedBefore = await Effect.runPromise(credentials.readForUse());
      expect(
        (await Effect.runPromise(credentials.readWithoutRefresh(openedBefore.identity)))
          .credentials["token"],
      ).toBe("old-token");

      await replaceToken(controller, serverId, "new-token");

      const failure = await Effect.runPromise(
        Effect.flip(credentials.readWithoutRefresh(openedBefore.identity)),
      );
      expect(failure).toBeInstanceOf(ServerCredentialsUnavailable);
      const openedAfter = await Effect.runPromise(credentials.readForUse());
      expect(
        (await Effect.runPromise(credentials.readWithoutRefresh(openedAfter.identity))).credentials[
          "token"
        ],
      ).toBe("new-token");
    });
  });

  it("changes its version on every new sign-in through setToken, even to the same token", async () => {
    await withUrlRig(async ({ controller, insertUrlServer }) => {
      const serverId = await insertUrlServer({ token: "old-token" });
      const signIns = await readSignIns(controller);
      const first = await Effect.runPromise(signIns.readVersion(serverId));

      await setTokenThroughApi(controller, serverId, "old-token");
      const second = await Effect.runPromise(signIns.readVersion(serverId));
      await setTokenThroughApi(controller, serverId, "old-token");
      const third = await Effect.runPromise(signIns.readVersion(serverId));

      expect(new Set([first, second, third]).size).toBe(3);
    });
  });

  it("changes its version when the token changes, and is removed with every secret of the server", async () => {
    await withUrlRig(async ({ controller, insertUrlServer }) => {
      const serverId = await insertUrlServer({ token: "old-token" });
      const signIns = await readSignIns(controller);
      const before = await Effect.runPromise(signIns.readVersion(serverId));

      await replaceToken(controller, serverId, "new-token");

      expect(await Effect.runPromise(signIns.readVersion(serverId))).not.toBe(before);

      await runSql(
        controller,
        Effect.provideService(
          signIns.deleteAll(serverId),
          SqlClient.SqlClient,
          controller.harness.sql,
        ),
      );

      expect(await Effect.runPromise(signIns.readToken(serverId, "token"))).toBeUndefined();
    });
  });
});

describe("a call that a new sign-in overtakes", () => {
  it("sends no request with the old token once setToken committed, while the call waited for the server's answer", async () => {
    await withUrlRig(
      async ({ controller, fake, insertUrlServer }) => {
        const serverId = await insertUrlServer({ token: "old-token" });
        await waitForResult(controller);
        const requestsBefore = fake.requests.length;
        const release = fake.hold("initialize");

        const call = callAs(controller, serverId);
        await fake.waitForRequests(requestsBefore + 1);
        const heldIndex = fake.requests.length;
        await setTokenThroughApi(controller, serverId, "new-token");
        release();
        const result = await call;

        expect(result._tag).toBe("Failure");
        expect(requestsOf(fake, "tools/call")).toEqual([]);
        expect(
          fake.requests
            .slice(heldIndex)
            .filter((request) => request.authorization === "Bearer old-token"),
        ).toEqual([]);
      },
      { fake: { protocols: [McpProtocol.v2025_11_25] } },
    );
  });
});

describe("a check that a new sign-in overtakes", () => {
  it("sends no further request with the old token once setToken committed, while the check waited for the server's answer", async () => {
    await withUrlRig(
      async ({ controller, fake, insertUrlServer }) => {
        const serverId = await insertUrlServer({ token: "old-token" });
        await waitForResult(controller);
        const requestsBefore = fake.requests.length;
        const release = fake.hold("initialize");

        expect((await requestCheck(controller, serverId)).status).toBe(200);
        await fake.waitForRequests(requestsBefore + 1);
        const heldIndex = fake.requests.length;
        await setTokenThroughApi(controller, serverId, "new-token");
        release();

        // The check that the new sign-in asks for lists the tools with the new token.
        await eventually(
          () => Promise.resolve(fake.requests.slice(heldIndex)),
          (sent) => sent.some((request) => request.method === "tools/list"),
        );
        expect(
          fake.requests
            .slice(heldIndex)
            .filter((request) => request.authorization === "Bearer old-token"),
        ).toEqual([]);
      },
      { fake: { protocols: [McpProtocol.v2025_11_25] } },
    );
  });
});

describe("the request that ends an upstream session of a server added by URL", () => {
  it("carries the server's token when the server is switched off, which does not change the token", async () => {
    await withUrlRig(
      async ({ controller, fake, insertUrlServer }) => {
        const serverId = await insertUrlServer({ token: "old-token" });
        await waitForResult(controller);
        expect((await callAs(controller, serverId))._tag).toBe("Success");
        const endsBefore = requestsOf(fake, "?").length;

        expect((await requestUpdate(controller, serverId, { enabled: false })).status).toBe(200);

        const ends = await eventually(
          () => Promise.resolve(requestsOf(fake, "?")),
          (found) => found.length === endsBefore + 1,
        );
        expect(ends.at(-1)?.authorization).toBe("Bearer old-token");
      },
      { fake: { protocols: [McpProtocol.v2025_11_25] } },
    );
  });

  it("is not sent with the new token once setToken replaced the token the session opened with", async () => {
    await withUrlRig(
      async ({ controller, fake, insertUrlServer }) => {
        const serverId = await insertUrlServer({ token: "old-token" });
        await waitForResult(controller);
        expect((await callAs(controller, serverId))._tag).toBe("Success");
        const oldSession = requestsOf(fake, "tools/call").at(-1)?.sessionId;
        expect(oldSession).toBeTruthy();

        await setTokenThroughApi(controller, serverId, "new-token");
        await waitForResult(controller);
        await sleep(200);

        // The check the new token asks for ends its own session, which is not this one.
        const ends = requestsOf(fake, "?").filter((request) => request.sessionId === oldSession);
        expect(ends.map((request) => request.authorization)).not.toContain("Bearer new-token");
      },
      { fake: { protocols: [McpProtocol.v2025_11_25] } },
    );
  });
});

describe("an upstream session of a server added by URL", () => {
  /** Reads the MCP session id of each `tools/call` the fake received. */
  const sessionsOfCalls = (fake: FakeUpstream) =>
    requestsOf(fake, "tools/call").map((request) => request.sessionId);

  it("survives a check that writes a new check time with the same tools, and is replaced when the sign-in was replaced", async () => {
    await withUrlRig(
      async ({ controller, fake, insertUrlServer }) => {
        const serverId = await insertUrlServer({ token: "old-token" });
        const first = await waitForResult(controller);
        expect((await callAs(controller, serverId))._tag).toBe("Success");

        // The daily check: it writes `checkedAt` and no revision.
        await runSql(
          controller,
          controller.harness.sql`UPDATE mcp_servers SET next_check_at = '2020-01-01T00:00:00.000Z'`,
        );
        const checked = await eventually(
          () => readRow(controller),
          (row) => row.checked_at !== first.checked_at,
        );
        expect(checked.revision).toBe(first.revision);
        // The sessions that lost their destination are closed right after the
        // write is announced.
        await sleep(200);
        expect((await callAs(controller, serverId))._tag).toBe("Success");

        const [opened, after] = sessionsOfCalls(fake);
        expect(opened).not.toBeNull();
        expect(after).toBe(opened);

        await replaceToken(controller, serverId, "new-token");
        expect((await callAs(controller, serverId))._tag).toBe("Success");

        const calls = requestsOf(fake, "tools/call");
        expect(calls[2]?.sessionId).not.toBe(opened);
        expect(calls[2]?.authorization).toBe("Bearer new-token");
      },
      { fake: { protocols: [McpProtocol.v2025_11_25] } },
    );
  });
});

describe("a credential the server echoes", () => {
  it("is removed from the tool definitions that are stored and from the answer of a call", async () => {
    await withUrlRig(
      async ({ controller, fake, insertUrlServer }) => {
        fake.intercept = ({ method, id, authorization }) =>
          method === "tools/call"
            ? Response.json({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: `you sent ${authorization}` }] },
              })
            : undefined;
        const serverId = await insertUrlServer({ token: "s3cret-t0ken" });

        const row = await waitForResult(controller);
        const result = await callAs(controller, serverId, { tool: "plain" });

        expect(row.status).toBe("ready");
        expect(row.tools).not.toContain("s3cret-t0ken");
        expect(JSON.parse(row.tools)).toMatchObject([
          { name: "plain", description: "sent Bearer [removed] to this tool" },
        ]);
        expect(JSON.stringify(result)).not.toContain("s3cret-t0ken");
        expect(result).toMatchObject({
          _tag: "Success",
          success: { content: [{ text: "you sent Bearer [removed]" }] },
        });
      },
      {
        fake: {
          tools: [
            { name: "Bearer s3cret-t0ken", description: "named after the credential" },
            { name: "plain", description: "sent Bearer s3cret-t0ken to this tool" },
          ],
        },
      },
    );
  });

  it("is removed when it is a value in the address's query", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      fake.intercept = ({ method, id, url }) =>
        method === "tools/call"
          ? Response.json({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `you called ${url}` }] },
            })
          : undefined;
      const serverId = await insertUrlServerAt(
        controller,
        `${fake.url}?api_key=k3y-9f2a7c&org=acme`,
      );
      await waitForResult(controller);

      const result = await callAs(controller, serverId);

      expect(result).toMatchObject({
        _tag: "Success",
        success: { content: [{ text: "you called /mcp?api_key=[removed]&org=[removed]" }] },
      });
    });
  });

  it("leaves out a tool that no longer fits the tool schema once the credential is removed from one of its keys", async () => {
    await withUrlRig(
      async ({ controller, insertUrlServer }) => {
        // The shortest token that is accepted is 8 characters, and this one is
        // the start of the required key `inputSchema`.
        await insertUrlServer({ token: "inputSch" });

        const row = await waitForResult(controller);

        expect(row.status).toBe("ready");
        expect(JSON.parse(row.tools)).toEqual([]);
      },
      { fake: { tools: [{ name: "echo", description: "Echoes its text" }] } },
    );
  });

  it("is replaced by an error result when removing the credential breaks the result's shape", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      // The shortest token that is accepted is 8 characters, and this one is
      // the name of the key `mimeType`, which an image result requires.
      const serverId = await insertUrlServer({ token: "mimeType" });
      await waitForResult(controller);
      fake.intercept = ({ method, id }) =>
        method === "tools/call"
          ? Response.json({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
            })
          : undefined;

      const result = await callAs(controller, serverId);

      expect(result).toMatchObject({
        _tag: "Success",
        success: {
          isError: true,
          content: [
            {
              type: "text",
              text: "The server's answer held the credential and could not be cleaned.",
            },
          ],
        },
      });
    });
  });

  it("is removed from the error a tool answers with", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer({ token: "s3cret-t0ken" });
      await waitForResult(controller);
      fake.intercept = ({ method, id, authorization }) =>
        method === "tools/call"
          ? Response.json({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `bad request from ${authorization}` },
            })
          : undefined;

      const result = await callAs(controller, serverId);

      expect(JSON.stringify(result)).not.toContain("s3cret-t0ken");
      expect(result).toMatchObject({
        _tag: "Success",
        success: { isError: true, content: [{ text: "bad request from Bearer [removed]" }] },
      });
    });
  });
});

describe("the size of a tool list", () => {
  const BIG_DESCRIPTION = "x".repeat(1536 * 1024);

  it("stops at the first page that passes 4 MiB, ends the check as an error, and keeps the last tools", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer();
      const first = await waitForResult(controller);
      const listsBefore = requestsOf(fake, "tools/list").length;
      let page = 0;
      fake.intercept = ({ method, id }) => {
        if (method !== "tools/list") return undefined;
        page += 1;
        return buildListPage(
          id,
          [{ name: `big-${String(page)}`, description: BIG_DESCRIPTION }],
          `cursor-${String(page)}`,
        );
      };

      expect((await requestCheck(controller, serverId)).status).toBe(200);
      const row = await waitForStatus(controller, "error");

      expect(row.status_detail).toBe("The server's tool list is larger than 4 MiB");
      expect(row.tools).toBe(first.tools);
      // 3 pages of 1.5 MiB pass 4 MiB, and no fourth page is asked for.
      expect(requestsOf(fake, "tools/list").length - listsBefore).toBe(3);
    });
  });

  it("counts each tool as the client keeps it, so large `_meta` fields end the check as an error", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer();
      const first = await waitForResult(controller);
      const listsBefore = requestsOf(fake, "tools/list").length;
      let page = 0;
      fake.intercept = ({ method, id }) => {
        if (method !== "tools/list") return undefined;
        page += 1;
        // What is stored of each tool is a few bytes. Only `_meta` is large.
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            ttlMs: 0,
            cacheScope: "private",
            tools: [
              {
                name: `meta-${String(page)}`,
                description: "small",
                inputSchema: { type: "object" },
                _meta: { padding: BIG_DESCRIPTION },
              },
            ],
            nextCursor: `cursor-${String(page)}`,
          },
        });
      };

      expect((await requestCheck(controller, serverId)).status).toBe(200);
      const row = await waitForStatus(controller, "error");

      expect(row.status_detail).toBe("The server's tool list is larger than 4 MiB");
      expect(row.tools).toBe(first.tools);
      expect(requestsOf(fake, "tools/list").length - listsBefore).toBe(3);
    });
  });

  it("stops after 100 pages, ends the check as an error, and keeps the last tools", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      const serverId = await insertUrlServer();
      const first = await waitForResult(controller);
      const listsBefore = requestsOf(fake, "tools/list").length;
      let page = 0;
      fake.intercept = ({ method, id }) => {
        if (method !== "tools/list") return undefined;
        page += 1;
        return buildListPage(
          id,
          [{ name: `tool-${String(page)}`, description: "small" }],
          `cursor-${String(page)}`,
        );
      };

      expect((await requestCheck(controller, serverId)).status).toBe(200);
      const row = await waitForStatus(controller, "error");

      expect(row.status_detail).toBe(
        "The server's tool list has more than 100 pages or 10,000 tools",
      );
      expect(row.tools).toBe(first.tools);
      expect(requestsOf(fake, "tools/list").length - listsBefore).toBe(100);
    });
  });

  it("still lists a plugin server's tools over two pages", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      fake.intercept = ({ method, id, params }) => {
        if (method !== "tools/list") return undefined;
        return params?.["cursor"] === undefined
          ? buildListPage(id, [{ name: "first", description: "page one" }], "page-2")
          : buildListPage(id, [{ name: "second", description: "page two" }]);
      };
      await createServer(controller, { connectionId: await connect() });

      const row = await waitForResult(controller);

      expect(row.status).toBe("ready");
      expect(JSON.parse(row.tools)).toMatchObject([{ name: "first" }, { name: "second" }]);
    });
  });
});

describe("the follower", () => {
  it("leaves a server added by URL alone when a Connection changes", async () => {
    await withRig(async ({ controller, connect }) => {
      const connectionId = await connect();
      await createServer(controller, { connectionId });
      await eventually(
        () => readRow(controller),
        (row) => row.status === "ready",
      );
      const urlRow = (): Promise<McpServerRow> =>
        runSql(
          controller,
          controller.harness
            .sql<McpServerRow>`SELECT status, status_detail, status_cause, tools, checked_at,
                  protocol_version, revision, connection_generation, failed_checks, next_check_at,
                  updated_at, notified_status, sign_in_offered
                FROM mcp_servers WHERE source_kind = 'url'`,
        ).then((rows) => rows[0]!);
      // A server added by URL, as a check would leave it.
      await runSql(
        controller,
        controller.harness.sql`INSERT INTO mcp_servers
          (id, name, source_kind, url, normalized_url, sign_in, enabled, status, checked_at,
           created_at, updated_at)
          VALUES (randomblob(16), 'remote', 'url', 'http://127.0.0.1:1/mcp', 'http://127.0.0.1:1/mcp',
                  'none', 1, 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                  '2026-01-01T00:00:00.000Z')`,
      );
      const before = await urlRow();

      await runSql(
        controller,
        controller.harness.sql`UPDATE connections SET status = 'needs-reauth'`,
      );
      const renamed = await send("PATCH", controller.base, `/api/v1/connections/${connectionId}`, {
        body: { label: "renamed" },
        token: controller.token,
      });
      expect(renamed.status).toBe(200);
      await eventually(
        () =>
          runSql(
            controller,
            controller.harness.sql<{
              readonly status: string;
            }>`SELECT status FROM mcp_servers WHERE source_kind = 'plugin'`,
          ),
        (rows) => rows[0]?.status === "needs-sign-in",
      );

      expect(await urlRow()).toEqual(before);
    });
  });
});
