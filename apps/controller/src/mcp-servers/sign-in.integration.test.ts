/**
 * Tests the OAuth sign-in of an MCP Server added by URL over HTTP, against a
 * real controller, a fake MCP server that accepts only the tokens its
 * authorization server issued, and a fake authorization server that checks
 * what a real one checks (PKCE, the redirect address, the client, the
 * `resource`) and rotates its refresh tokens:
 *
 * - a sign-in ends in `ready` with the server's tools, and uses the client it
 *   registered; a second sign-in uses the same client, and a changed token
 *   endpoint gets a new client;
 * - tokens that are about to expire are refreshed before a request, a token the
 *   server refuses is refreshed and the request is retried, and a refresh the
 *   provider refuses makes the server need sign-in;
 * - a finish is refused, and says why, for a wrong, used, replaced or expired
 *   attempt, for a sign-in that a pasted token overtook, for an answer with an
 *   error, a wrong `iss` or one that is missing when it was promised, and for
 *   text that is not a redirect answer;
 * - a start is refused for a plugin server, a server with no OAuth, an
 *   authorization server that cannot be reached, and a redirect on a metadata
 *   request;
 * - no token, code or verifier is in any answer, audit entry, Notification or
 *   row of the database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { McpProtocol } from "effect/ai";
import { uuidFromString } from "../db";
import { del } from "../http/testing";
import type { SetUpController } from "../workflows/testing";
import {
  countNotifications,
  createServer,
  eventually,
  readRecord,
  readRefusal,
  readRow,
  callAs,
  readServer,
  runSql,
  requestCheck,
  requestFinishSignIn,
  requestStartSignIn,
  sendToken,
  signInWithBrowser,
  startSignIn,
  TEST_REDIRECT_URI,
  waitForStatus,
  withOAuthRig,
  withRig,
  withUrlRig,
  type OAuthRig,
} from "./testing";

afterEach(() => {
  vi.useRealTimers();
});

/** Returns every row of every table as one text, so a test can look for a value anywhere in the database. */
const dumpDatabase = (controller: SetUpController): Promise<string> =>
  runSql(
    controller,
    Effect.gen(function* () {
      const sql = controller.harness.sql;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
      const dumped: Array<unknown> = [];
      for (const { name } of tables) {
        dumped.push(yield* sql`SELECT * FROM ${sql(name)}`);
      }
      return JSON.stringify(dumped);
    }),
  );

/** Reads the sign-in columns of the server's row. */
const readSignInColumns = (controller: SetUpController, serverId: string) =>
  runSql(
    controller,
    controller.harness.sql<{
      readonly sign_in: string;
      readonly sign_in_generation: number;
    }>`SELECT sign_in, sign_in_generation FROM mcp_servers WHERE id = ${uuidFromString(serverId)}`,
  ).then((rows) => rows[0]!);

/** Adds a server at the fake MCP server's address and waits until its first check says it needs sign-in. */
const addServerThatNeedsSignIn = async (rig: OAuthRig): Promise<string> => {
  const serverId = await rig.insertUrlServer();
  await waitForStatus(rig.controller, "needs-sign-in");
  return serverId;
};

/** The `Authorization` headers of the fake MCP server's `tools/list` requests. */
const listAuthorizations = (rig: OAuthRig) =>
  rig.fake.requests
    .filter((request) => request.method === "tools/list")
    .map((request) => request.authorization);

/** Starts a sign-in and approves it in the browser, and returns the address the browser ended on. */
const startAndApprove = async (
  rig: OAuthRig,
  serverId: string,
  approval?: Parameters<OAuthRig["authorizationServer"]["approve"]>[1],
): Promise<string> => {
  const { authorizationUrl } = await startSignIn(rig.controller, serverId);
  return rig.authorizationServer.approve(authorizationUrl, approval);
};

describe("signing in through the browser", () => {
  it("ends in ready with the server's tools, and the requests carry the issued token", async () => {
    await withOAuthRig(async (rig) => {
      const { controller, authorizationServer } = rig;
      const serverId = await addServerThatNeedsSignIn(rig);

      const finished = await signInWithBrowser(rig, serverId);

      expect(finished).toMatchObject({
        id: serverId,
        status: "checking",
        source: { kind: "url", signIn: "oauth" },
      });
      const row = await waitForStatus(controller, "ready");
      expect(JSON.parse(row.tools)).toMatchObject([{ name: "echo" }]);
      expect(listAuthorizations(rig).at(-1)).toBe(
        `Bearer ${authorizationServer.currentAccessToken()}`,
      );
      expect(authorizationServer.registrations).toEqual([
        {
          client_name: "Hercule",
          redirect_uris: ["http://127.0.0.1/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "native",
        },
      ]);
      expect(authorizationServer.tokenRequests).toEqual([
        expect.objectContaining({
          grant_type: "authorization_code",
          client_id: "client-1",
          redirect_uri: TEST_REDIRECT_URI,
          resource: rig.fake.url,
        }),
      ]);
      expect(await readSignInColumns(controller, serverId)).toEqual({
        sign_in: "oauth",
        sign_in_generation: 1,
      });
      const [audited] = await controller.harness.audit("mcpServer.updated");
      expect(audited?.payload).toEqual({ mcpServerId: serverId, signIn: "oauth" });
    });
  });

  it("asks the authorization server with the scope and the resource the server named", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);

      const { authorizationUrl, expiresAt } = await startSignIn(rig.controller, serverId);

      const url = new URL(authorizationUrl);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        response_type: "code",
        client_id: "client-1",
        redirect_uri: TEST_REDIRECT_URI,
        code_challenge_method: "S256",
        resource: rig.fake.url,
        scope: "mcp.read",
      });
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60 * 1000);
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    });
  });

  it("accepts the query of the redirect alone as well as the whole address", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId);

      const finished = await readRecord(
        await requestFinishSignIn(rig.controller, serverId, new URL(callback).search),
      );

      expect(finished.source).toMatchObject({ signIn: "oauth" });
    });
  });

  it("replaces a pasted token, and then a pasted token replaces the sign-in", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await rig.insertUrlServer({ token: "pasted-token-1" });
      await waitForStatus(rig.controller, "needs-sign-in");

      await signInWithBrowser(rig, serverId);
      expect(await readSignInColumns(rig.controller, serverId)).toMatchObject({ sign_in: "oauth" });
      await waitForStatus(rig.controller, "ready");

      await readRecord(await sendToken(rig.controller, serverId, "pasted-token-2"));
      expect(await readSignInColumns(rig.controller, serverId)).toEqual({
        sign_in: "token",
        sign_in_generation: 2,
      });
      const secrets = await rig.controller.harness.secrets
        .refs("mcp-server", [serverId])
        .pipe(Effect.runPromise);
      expect(secrets.get(serverId)?.map((secret) => secret.name)).toEqual(["token"]);
    });
  });
});

describe("a client of the authorization server", () => {
  it("is registered once and used again by the next sign-in", async () => {
    await withOAuthRig(async (rig) => {
      const { authorizationServer } = rig;
      const serverId = await addServerThatNeedsSignIn(rig);
      await signInWithBrowser(rig, serverId);

      const second = await startSignIn(rig.controller, serverId);

      expect(authorizationServer.registrations).toHaveLength(1);
      expect(new URL(second.authorizationUrl).searchParams.get("client_id")).toBe("client-1");
    });
  });

  it("is replaced by a new one when the token endpoint is another", async () => {
    await withOAuthRig(async (rig) => {
      const { authorizationServer } = rig;
      const serverId = await addServerThatNeedsSignIn(rig);
      await signInWithBrowser(rig, serverId);
      authorizationServer.tokenPath = "/token-2";

      const second = await startSignIn(rig.controller, serverId);

      expect(authorizationServer.registrations).toHaveLength(2);
      expect(new URL(second.authorizationUrl).searchParams.get("client_id")).toBe("client-2");
    });
  });
});

describe("the tokens of a sign-in", () => {
  it("are refreshed before they expire, and the rotated refresh token is the one stored", async () => {
    await withOAuthRig(async (rig) => {
      const { controller, authorizationServer } = rig;
      // A token with no lifetime left is stale at once.
      authorizationServer.firstExpiresIn = 0;
      const serverId = await addServerThatNeedsSignIn(rig);

      await signInWithBrowser(rig, serverId);
      await waitForStatus(controller, "ready");

      expect(authorizationServer.tokenRequests.map((form) => form.grant_type)).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      expect(authorizationServer.tokenRequests[1]).toMatchObject({
        refresh_token: "refresh-token-1",
        client_id: "client-1",
        resource: rig.fake.url,
      });
      expect(listAuthorizations(rig).at(-1)).toBe("Bearer access-token-2");

      // A server that refuses the token gets another refresh, and with the
      // token the first refresh rotated to.
      authorizationServer.revokeAccessTokens();
      await requestCheck(controller, serverId);
      await eventually(
        () => Promise.resolve(authorizationServer.tokenRequests.length),
        (count) => count >= 3,
      );
      expect(authorizationServer.tokenRequests[2]).toMatchObject({
        refresh_token: "refresh-token-2",
      });
      await eventually(
        () => Promise.resolve(listAuthorizations(rig).at(-1)),
        (header) => header === "Bearer access-token-3",
      );
    });
  });

  it("are refreshed once, not in a loop, when the provider issues tokens that live 5 minutes", async () => {
    await withOAuthRig(async (rig) => {
      const { controller, authorizationServer } = rig;
      authorizationServer.expiresIn = 300;
      // The first token has no lifetime left, so the first request refreshes it.
      authorizationServer.firstExpiresIn = 0;
      const serverId = await addServerThatNeedsSignIn(rig);

      await signInWithBrowser(rig, serverId);
      await waitForStatus(controller, "ready");
      const checkedBefore = (await readRow(controller)).checked_at;
      await requestCheck(controller, serverId);
      await eventually(
        () => readRow(controller),
        (row) => row.checked_at !== checkedBefore,
      );

      expect(authorizationServer.tokenRequests.map((form) => form.grant_type)).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      expect(listAuthorizations(rig).at(-1)).toBe("Bearer access-token-2");
    });
  });

  it("are refreshed after the server refused the access token, and the request is tried again", async () => {
    await withOAuthRig(async (rig) => {
      const { controller, authorizationServer } = rig;
      const serverId = await addServerThatNeedsSignIn(rig);
      await signInWithBrowser(rig, serverId);
      await waitForStatus(controller, "ready");
      const checkedBefore = (await readRow(controller)).checked_at;

      authorizationServer.revokeAccessTokens();
      await requestCheck(controller, serverId);

      await eventually(
        () => readRow(controller),
        (row) => row.checked_at !== checkedBefore,
      );
      expect(authorizationServer.tokenRequests.at(-1)).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "refresh-token-1",
      });
      expect(listAuthorizations(rig).at(-1)).toBe("Bearer access-token-2");
      expect((await readRow(controller)).status).toBe("ready");
    });
  });

  it("are refreshed once when two calls find the access token refused at the same time", async () => {
    await withOAuthRig(async (rig) => {
      const { controller, authorizationServer } = rig;
      const serverId = await addServerThatNeedsSignIn(rig);
      await signInWithBrowser(rig, serverId);
      await waitForStatus(controller, "ready");

      authorizationServer.revokeAccessTokens();
      const results = await Promise.all([
        callAs(controller, serverId),
        callAs(controller, serverId),
      ]);

      expect(results.map((result) => result._tag)).toEqual(["Success", "Success"]);
      expect(
        authorizationServer.tokenRequests.filter((form) => form.grant_type === "refresh_token"),
      ).toHaveLength(1);
    });
  });

  it("make the server need sign-in when the provider refuses the refresh, without the provider's words", async () => {
    await withOAuthRig(async (rig) => {
      const { controller, authorizationServer } = rig;
      const serverId = await addServerThatNeedsSignIn(rig);
      await signInWithBrowser(rig, serverId);
      await waitForStatus(controller, "ready");

      authorizationServer.refuseRefresh = true;
      authorizationServer.revokeAccessTokens();
      await requestCheck(controller, serverId);

      const row = await waitForStatus(controller, "needs-sign-in");
      expect(row.status_detail).toBe(
        "remote's sign-in has expired: paste a token or sign in in Settings > MCP servers",
      );
      expect(await countNotifications(controller)).toBe(1);
    });
  });
});

describe("an upstream session of a signed-in server", () => {
  it("is replaced when a refresh rotated the token, so a reply to a request of the server carries the token that session opened with", async () => {
    await withOAuthRig(
      async (rig) => {
        const { controller, authorizationServer, fake } = rig;
        const serverId = await addServerThatNeedsSignIn(rig);
        await signInWithBrowser(rig, serverId);
        await waitForStatus(controller, "ready");
        expect((await callAs(controller, serverId))._tag).toBe("Success");
        const requestsBefore = fake.requests.length;

        // The next call finds its token refused, so a refresh rotates it, and
        // the server then asks the client for a reply (a ping).
        authorizationServer.revokeAccessTokens();
        fake.intercept = ({ method }) =>
          method === "tools/call"
            ? new Response(
                `data: ${JSON.stringify({ jsonrpc: "2.0", id: "from-server", method: "ping" })}\n\n`,
                { status: 200, headers: { "content-type": "text/event-stream" } },
              )
            : method === "?"
              ? new Response(null, { status: 202 })
              : undefined;
        await callAs(controller, serverId);

        const during = fake.requests.slice(requestsBefore);
        // A reply has no JSON-RPC method, which the fake records as `?`.
        const replies = during.filter((request) => request.method === "?");
        expect(replies.map((reply) => [reply.authorization, reply.status])).toEqual([
          [`Bearer ${authorizationServer.currentAccessToken()}`, 202],
        ]);
        // The session the old token opened was replaced by one opened with the new token.
        expect(
          during
            .filter((request) => request.method === "initialize")
            .map((request) => request.authorization),
        ).toEqual([`Bearer ${authorizationServer.currentAccessToken()}`]);
      },
      { fake: { protocols: [McpProtocol.v2025_11_25] } },
    );
  });
});

describe("a call whose sign-in cannot be renewed", () => {
  it("makes the server need sign-in, once, and the next call does not try the refresh again", async () => {
    await withOAuthRig(async (rig) => {
      const { controller, authorizationServer } = rig;
      const serverId = await addServerThatNeedsSignIn(rig);
      await signInWithBrowser(rig, serverId);
      await waitForStatus(controller, "ready");

      authorizationServer.refuseRefresh = true;
      authorizationServer.revokeAccessTokens();
      const result = await callAs(controller, serverId);

      expect(result._tag).toBe("Failure");
      const row = await waitForStatus(controller, "needs-sign-in");
      expect(row.status_detail).toBe(
        "remote's sign-in has expired: paste a token or sign in in Settings > MCP servers",
      );
      expect(row.sign_in_offered).toBe("oauth");
      expect(await countNotifications(controller)).toBe(1);
      const refreshes = () =>
        authorizationServer.tokenRequests.filter((form) => form.grant_type === "refresh_token")
          .length;
      const before = refreshes();

      // The catalogue no longer serves the server, so the call stops before the provider.
      expect((await callAs(controller, serverId))._tag).toBe("Failure");
      expect(refreshes()).toBe(before);
    });
  });

  it("keeps offering the browser when a later 401 names no OAuth metadata", async () => {
    await withOAuthRig(async (rig) => {
      const { controller, fake } = rig;
      const serverId = await addServerThatNeedsSignIn(rig);
      await signInWithBrowser(rig, serverId);
      await waitForStatus(controller, "ready");

      fake.challenge = "Bearer";
      fake.authorize = () => false;
      await requestCheck(controller, serverId);

      const row = await waitForStatus(controller, "needs-sign-in");
      expect(row.sign_in_offered).toBe("oauth");
    });
  });
});

describe("finishing a sign-in", () => {
  /** Finishes with `callback`, which must be refused with `status`, and returns the refusal. */
  const refusal = async (rig: OAuthRig, serverId: string, callback: string, status: number) =>
    readRefusal(await requestFinishSignIn(rig.controller, serverId, callback), status);

  /** Checks that the sign-in did not happen: the server holds no OAuth sign-in. */
  const expectNotSignedIn = async (rig: OAuthRig, serverId: string) => {
    expect((await readSignInColumns(rig.controller, serverId)).sign_in).toBe("none");
  };

  it("is refused for another state, as a sign-in that is gone", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId, { state: "another-state" });

      const error = await refusal(rig, serverId, callback, 409);

      expect(error).toMatchObject({
        code: "invalid_state",
        details: { reason: "sign-in-expired" },
      });
      expect(error.message).toContain(`hercule mcp-server sign-in ${serverId}`);
      expect(rig.authorizationServer.tokenRequests).toEqual([]);
      await expectNotSignedIn(rig, serverId);
    });
  });

  it("is refused once ten minutes have passed", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId);

      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60 * 1000 + 1000 });
      const error = await refusal(rig, serverId, callback, 409);
      vi.useRealTimers();

      expect(error.details).toEqual({ reason: "sign-in-expired" });
      expect(rig.authorizationServer.tokenRequests).toEqual([]);
      await expectNotSignedIn(rig, serverId);
    });
  });

  it("is refused for an attempt that a newer start replaced, and the newer one still works", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const first = await startAndApprove(rig, serverId);
      const second = await startAndApprove(rig, serverId);

      expect((await refusal(rig, serverId, first, 409)).details).toEqual({
        reason: "sign-in-expired",
      });
      const finished = await readRecord(
        await requestFinishSignIn(rig.controller, serverId, second),
      );

      expect(finished.source).toMatchObject({ signIn: "oauth" });
    });
  });

  it("is refused for a server that was deleted after the start", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId);
      await del(rig.controller.base, `/api/v1/mcp-servers/${serverId}`, rig.controller.token);

      await refusal(rig, serverId, callback, 404);

      expect(rig.authorizationServer.tokenRequests).toEqual([]);
    });
  });

  it("is refused the second time the same answer is sent", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId);
      await readRecord(await requestFinishSignIn(rig.controller, serverId, callback));

      expect((await refusal(rig, serverId, callback, 409)).details).toEqual({
        reason: "sign-in-expired",
      });
      expect(rig.authorizationServer.tokenRequests).toHaveLength(1);
    });
  });

  it("is refused when a token was pasted after the start, and keeps the pasted token", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId);
      await readRecord(await sendToken(rig.controller, serverId, "pasted-token-1"));

      expect((await refusal(rig, serverId, callback, 409)).details).toEqual({
        reason: "sign-in-expired",
      });

      // The void attempt sent neither its code nor its verifier.
      expect(rig.authorizationServer.tokenRequests).toEqual([]);
      expect(await readSignInColumns(rig.controller, serverId)).toMatchObject({ sign_in: "token" });
    });
  });

  it("is refused when the user said no, and names the standard code and none of the provider's words", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId, { deny: true });

      const error = await refusal(rig, serverId, callback, 409);

      expect(error).toMatchObject({ details: { reason: "sign-in-refused" } });
      expect(error.message).toContain("access_denied");
      expect(error.message).not.toContain("SECRET-DESCRIPTION");
      await expectNotSignedIn(rig, serverId);
    });
  });

  it.each([
    ["a wrong iss", { iss: "https://evil.example" }],
    ["a wrong iss on an error answer", { iss: "https://evil.example", deny: true }],
    ["no iss when the metadata promised it", { iss: null }],
  ])("is refused for %s, before the code is sent", async (_name, approval) => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId, approval);

      const error = await refusal(rig, serverId, callback, 409);

      expect(error).toMatchObject({ details: { reason: "sign-in-refused" } });
      expect(rig.authorizationServer.tokenRequests).toEqual([]);
      await expectNotSignedIn(rig, serverId);
    });
  });

  it("accepts an answer with no iss when the metadata did not promise it, and refuses a wrong one all the same", async () => {
    await withOAuthRig(async (rig) => {
      rig.authorizationServer.sendsIssuer = false;
      const serverId = await addServerThatNeedsSignIn(rig);
      const wrong = await startAndApprove(rig, serverId, { iss: "https://evil.example" });
      expect((await refusal(rig, serverId, wrong, 409)).details).toEqual({
        reason: "sign-in-refused",
      });

      const callback = await startAndApprove(rig, serverId);
      expect(new URL(callback).searchParams.has("iss")).toBe(false);
      const finished = await readRecord(
        await requestFinishSignIn(rig.controller, serverId, callback),
      );

      expect(finished.source).toMatchObject({ signIn: "oauth" });
    });
  });

  it.each([
    ["a repeated parameter", (callback: string) => `${callback}&code=another`],
    ["no state", (callback: string) => callback.replace(/state=[^&]*&?/, "")],
    ["text that is not a redirect answer", () => "hello"],
    ["an address that is not one", () => "http://[bad"],
  ])("is refused as validation for %s, and leaves the attempt", async (_name, damage) => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId);

      const error = await refusal(rig, serverId, damage(callback), 400);

      expect(error.code).toBe("validation");
      expect(error.message).not.toContain(new URL(callback).searchParams.get("code")!);
      const finished = await readRecord(
        await requestFinishSignIn(rig.controller, serverId, callback),
      );
      expect(finished.source).toMatchObject({ signIn: "oauth" });
    });
  });

  it("is refused as validation for the address of another redirect address, and leaves the attempt", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId);
      const otherPort = callback.replace(":50123", ":50124");

      const error = await refusal(rig, serverId, otherPort, 400);

      expect(error.code).toBe("validation");
      const finished = await readRecord(
        await requestFinishSignIn(rig.controller, serverId, callback),
      );
      expect(finished.source).toMatchObject({ signIn: "oauth" });
    });
  });

  it("uses an attempt up when the authorization server refuses the code", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId);
      // A code the fake never issued.
      const forged = callback.replace(/code=[^&]*/, "code=forged-code");

      const error = await refusal(rig, serverId, forged, 409);

      expect(error).toMatchObject({ details: { reason: "sign-in-refused" } });
      expect(error.message).toContain("invalid_grant");
      expect((await refusal(rig, serverId, callback, 409)).details).toEqual({
        reason: "sign-in-expired",
      });
    });
  });

  it("is refused as unreadable when the token endpoint cannot be reached", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const callback = await startAndApprove(rig, serverId);
      await rig.authorizationServer.stop();

      const error = await refusal(rig, serverId, callback, 409);

      expect(error).toMatchObject({ details: { reason: "source-unreadable" } });
      await expectNotSignedIn(rig, serverId);
    });
  });
});

describe("starting a sign-in", () => {
  it("is refused for a plugin server, which is signed in through its Connection", async () => {
    await withRig(async ({ controller, connect }) => {
      const server = await createServer(controller, { connectionId: await connect() });

      const start = await readRefusal(await requestStartSignIn(controller, server.id), 409);
      const finish = await readRefusal(
        await requestFinishSignIn(controller, server.id, "code=a&state=b"),
        409,
      );

      expect(start.details).toBeUndefined();
      expect(start.message).toContain("reconnect that Connection in Settings > Connections");
      expect(finish.details).toBeUndefined();
    });
  });

  it("is refused for an unknown server", async () => {
    await withOAuthRig(async (rig) => {
      const unknown = "0199e0e7-7b21-7000-8000-0000000000ff";
      await readRefusal(await requestStartSignIn(rig.controller, unknown), 404);
      await readRefusal(await requestFinishSignIn(rig.controller, unknown, "code=a&state=b"), 404);
    });
  });

  it("is refused as validation for a redirect address that is not the loopback form", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);

      const response = await requestStartSignIn(
        rig.controller,
        serverId,
        "http://localhost:1/callback",
      );

      expect((await readRefusal(response, 400)).code).toBe("validation");
    });
  });

  it("is unsupported for a server with no OAuth metadata, and says to paste a token", async () => {
    await withUrlRig(async ({ controller, fake, insertUrlServer }) => {
      fake.authorize = () => false;
      const serverId = await insertUrlServer();
      await waitForStatus(controller, "needs-sign-in");

      const error = await readRefusal(await requestStartSignIn(controller, serverId), 409);

      expect(error.details).toEqual({ reason: "sign-in-unsupported" });
      expect(error.message).toContain(`hercule mcp-server set-token ${serverId}`);
    });
  });

  it("is unreadable when the authorization server cannot be reached", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      await rig.authorizationServer.stop();

      const error = await readRefusal(await requestStartSignIn(rig.controller, serverId), 409);

      expect(error.details).toEqual({ reason: "source-unreadable" });
      expect(error.message).toContain("Try again later");
    });
  });

  it("does not follow a redirect on a metadata request", async () => {
    const reached: Array<string> = [];
    const elsewhere = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        reached.push(new URL(request.url).pathname);
        return Response.json({});
      },
    });
    try {
      await withOAuthRig(async (rig) => {
        const serverId = await addServerThatNeedsSignIn(rig);
        rig.authorizationServer.redirectMetadataTo = `http://127.0.0.1:${String(elsewhere.port)}/metadata`;

        const error = await readRefusal(await requestStartSignIn(rig.controller, serverId), 409);

        expect(error.details).toEqual({ reason: "source-unreadable" });
        expect(error.message).toContain("redirect");
        expect(reached).toEqual([]);
      });
    } finally {
      await elsewhere.stop(true);
    }
  });

  it("is unreadable when the metadata is larger than the limit", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const publish = rig.fake.answerFirst;
      rig.fake.answerFirst = (request) =>
        new URL(request.url).pathname.startsWith("/.well-known/")
          ? new Response("x".repeat(1024 * 1024 + 1), {
              headers: { "content-type": "application/json" },
            })
          : publish(request);

      const error = await readRefusal(await requestStartSignIn(rig.controller, serverId), 409);

      expect(error.details).toEqual({ reason: "source-unreadable" });
      expect(error.message).toContain("more than 1048576 bytes");
    });
  });

  it("does not replace the attempt of a start that began later, when it is the slower one", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      // The probe of the first start waits until the second start is done.
      const releaseFirst = rig.fake.hold("initialize");
      const arrived = rig.fake.requests.length;
      const first = requestStartSignIn(rig.controller, serverId);
      await rig.fake.waitForRequests(arrived + 1);
      const releaseSecond = rig.fake.hold("initialize");
      const second = requestStartSignIn(rig.controller, serverId);
      await rig.fake.waitForRequests(arrived + 2);
      releaseSecond();
      const newer = (await (await second).json()) as { readonly authorizationUrl: string };

      releaseFirst();

      expect((await readRefusal(await first, 409)).details).toEqual({
        reason: "sign-in-expired",
      });
      const callback = await rig.authorizationServer.approve(newer.authorizationUrl);
      const finished = await readRecord(
        await requestFinishSignIn(rig.controller, serverId, callback),
      );
      expect(finished.source).toMatchObject({ signIn: "oauth" });
    });
  });

  it("publishes no attempt when a token was pasted while the discovery ran", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const release = rig.fake.hold("initialize");
      const arrived = rig.fake.requests.length;
      const slow = requestStartSignIn(rig.controller, serverId);
      await rig.fake.waitForRequests(arrived + 1);
      await readRecord(await sendToken(rig.controller, serverId, "pasted-token-1"));

      release();

      expect((await readRefusal(await slow, 409)).details).toEqual({ reason: "sign-in-expired" });
      expect(await readSignInColumns(rig.controller, serverId)).toMatchObject({ sign_in: "token" });
    });
  });

  it("writes nothing to the database", async () => {
    await withOAuthRig(async (rig) => {
      const serverId = await addServerThatNeedsSignIn(rig);
      const before = await dumpDatabase(rig.controller);

      await startSignIn(rig.controller, serverId);

      expect(await dumpDatabase(rig.controller)).toBe(before);
    });
  });
});

describe("what a sign-in leaves behind", () => {
  it("holds no token, code or verifier in an answer, an audit entry, a Notification or a row", async () => {
    await withOAuthRig(async (rig) => {
      const { controller, authorizationServer } = rig;
      authorizationServer.firstExpiresIn = 0;
      const serverId = await addServerThatNeedsSignIn(rig);
      const { authorizationUrl } = await startSignIn(controller, serverId);
      const callback = await authorizationServer.approve(authorizationUrl);
      const code = new URL(callback).searchParams.get("code")!;
      const finishedResponse = await requestFinishSignIn(controller, serverId, callback);
      const finished = JSON.stringify(await readRecord(finishedResponse));
      await waitForStatus(controller, "ready");
      // A rejected token and a refused refresh put the failure paths in the dump too.
      authorizationServer.refuseRefresh = true;
      authorizationServer.revokeAccessTokens();
      await requestCheck(controller, serverId);
      await waitForStatus(controller, "needs-sign-in");

      const secrets = [
        code,
        "access-token-1",
        "access-token-2",
        "refresh-token-1",
        "refresh-token-2",
      ];
      const everything = [
        finished,
        JSON.stringify(await readServer(controller, serverId)),
        JSON.stringify(await controller.harness.audit("mcpServer.updated")),
        await dumpDatabase(controller),
      ].join("\n");
      for (const secret of secrets) {
        expect(everything, `the text holds ${secret}`).not.toContain(secret);
      }
    });
  });
});
