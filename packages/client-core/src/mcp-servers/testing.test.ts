/**
 * Tests the rules of the fake controller (`buildMcpControllerHandlers`): they
 * must be the real controller's, or a test that passes on the fake proves
 * nothing about the app. Each case names the refusal the controller gives.
 */
import { describe, expect, it } from "vitest";
import { readAuthorizationState } from "@hercule/contract";
import type { McpServer } from "@hercule/contract";
import type { Answer } from "../api-stub";
import {
  buildMcpControllerHandlers,
  buildMcpWorld,
  buildServer,
  SENTRY_WORK,
  type McpWorld,
} from "./testing";

const CREATED_ID = "s-created";
const URL_ID = "s-url";
const OTHER_ID = "s-other";
const TOKEN_URL = "https://docs.acme.example/mcp";
const REDIRECT = "http://127.0.0.1:4937/callback";

const buildUrlServer = (id: string, url: string, overrides: Partial<McpServer> = {}): McpServer =>
  buildServer(id, "docs", "unused", {
    source: { kind: "url", url, signIn: "none", signInOffered: "oauth" },
    ...overrides,
  });

const open = (servers: readonly McpServer[]) => {
  const world = buildMcpWorld({ servers, projects: [] });
  const handlers = buildMcpControllerHandlers(world, { createdIds: [CREATED_ID] });
  const send = async (route: string, body?: unknown): Promise<Answer> => {
    const handler = handlers[route]!;
    const call = { method: "", path: "", search: "", body, authorization: null };
    return typeof handler === "function" ? await handler(call) : handler;
  };
  return { world, send };
};

/** Returns the error envelope of a refused answer: its status, code and details. */
const readRefusal = (answer: Answer) => {
  const { error } = answer.body as {
    error: {
      code: string;
      message: string;
      details?: { reason?: string; issues?: { path: string[] }[] };
    };
  };
  return {
    status: answer.status,
    code: error.code,
    reason: error.details?.reason,
    paths: error.details?.issues?.map((issue) => issue.path.join(".")),
    message: error.message,
  };
};

const SERVERS = "/api/v1/mcp-servers";

describe("mcpServer.create", () => {
  it("refuses an address that is another spelling of a server's address, naming that server", async () => {
    const { send } = open([buildUrlServer(URL_ID, TOKEN_URL)]);

    const answer = await send(`POST ${SERVERS}`, {
      source: { kind: "url", url: "HTTPS://Docs.Acme.Example.:443/mcp/" },
    });

    expect(readRefusal(answer)).toMatchObject({
      status: 409,
      code: "conflict",
      reason: "mcp-server-exists",
    });
    expect((answer.body as { error: { details: { mcpServerId: string } } }).error.details).toEqual({
      reason: "mcp-server-exists",
      mcpServerId: URL_ID,
    });
  });

  it("does not take two addresses that differ in the case of the path for one", async () => {
    const { send, world } = open([buildUrlServer(URL_ID, TOKEN_URL)]);

    const answer = await send(`POST ${SERVERS}`, {
      source: { kind: "url", url: "https://docs.acme.example/MCP", name: "other" },
    });

    expect(answer.status).toBeUndefined();
    expect(world.servers.map((server) => server.id)).toEqual([URL_ID, CREATED_ID]);
  });

  it.each([
    ["is no address", "docs.acme.example", "source.url"],
    ["is not http", "ftp://docs.acme.example/mcp", "source.url"],
    ["holds a password", "https://me:secret@docs.acme.example/mcp", "source.url"],
    ["holds a fragment", "https://docs.acme.example/mcp#top", "source.url"],
  ])("refuses an address that %s, on source.url", async (_what, url, path) => {
    const { send } = open([]);

    const refusal = readRefusal(await send(`POST ${SERVERS}`, { source: { kind: "url", url } }));

    expect(refusal).toMatchObject({ status: 400, code: "validation", paths: [path] });
  });

  it("stores the address as the URL parser writes it, and names the server after its host", async () => {
    const { send } = open([]);

    const answer = await send(`POST ${SERVERS}`, {
      source: { kind: "url", url: "HTTPS://MCP.Notion.com:443/mcp" },
    });

    expect(answer.body).toMatchObject({
      id: CREATED_ID,
      name: "notion",
      source: { kind: "url", url: "https://mcp.notion.com/mcp", signIn: "none" },
    });
  });

  it("refuses a token that is too short or has a space, and stores a good one as the sign-in", async () => {
    const { send, world } = open([]);
    const create = (token: string) =>
      send(`POST ${SERVERS}`, { source: { kind: "url", url: TOKEN_URL, token } });

    expect(readRefusal(await create("short"))).toMatchObject({
      status: 400,
      paths: ["source.token"],
    });
    expect(readRefusal(await create("two words here"))).toMatchObject({ status: 400 });
    expect((await create("good-token-1")).body).toMatchObject({
      source: { signIn: "token" },
    });
    expect(world.tokens).toEqual([{ id: CREATED_ID, token: "good-token-1" }]);
  });

  it("refuses a second server of one contribution and Connection, and a Connection of another type", async () => {
    const { send } = open([SENTRY_WORK]);

    const second = await send(`POST ${SERVERS}`, {
      source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-work" },
    });
    const wrongType = await send(`POST ${SERVERS}`, {
      source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-linear" },
    });
    const unknown = await send(`POST ${SERVERS}`, {
      source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-gone" },
    });

    expect(readRefusal(second)).toMatchObject({ status: 409, reason: "mcp-server-exists" });
    expect(readRefusal(wrongType)).toMatchObject({
      status: 400,
      paths: ["source.connectionId"],
    });
    expect(readRefusal(unknown)).toMatchObject({ status: 400, paths: ["source.connectionId"] });
  });
});

describe("mcpServer.update", () => {
  const SENTRY_ADDRESS = "https://mcp.sentry.example/mcp";
  const onWork = {
    source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-work" },
  };

  it("refuses a payload with no field", async () => {
    const { send } = open([SENTRY_WORK]);

    expect(readRefusal(await send(`PATCH ${SERVERS}/${SENTRY_WORK.id}`, {}))).toMatchObject({
      status: 400,
      code: "validation",
    });
  });

  it("puts the status back to checking when it switches a server on, and leaves it when it switches off", async () => {
    const { send } = open([{ ...SENTRY_WORK, enabled: false }]);

    const on = await send(`PATCH ${SERVERS}/${SENTRY_WORK.id}`, { enabled: true });
    const off = await send(`PATCH ${SERVERS}/${SENTRY_WORK.id}`, { enabled: false });

    expect(on.body).toMatchObject({ enabled: true, status: "checking", statusDetail: null });
    expect(off.body).toMatchObject({ enabled: false, status: "checking" });
  });

  it("moves a server added by URL onto the plugin's Connection, keeping its id, name and tools", async () => {
    const tools = [{ name: "search", description: "Searches." }];
    const { send, world } = open([
      buildUrlServer(URL_ID, SENTRY_ADDRESS, { status: "ready", tools }),
    ]);
    world.signIns.set(URL_ID, {
      state: "s",
      redirectUri: REDIRECT,
      authorizationUrl: "x",
      expiresAtMillis: Infinity,
    });

    const answer = await send(`PATCH ${SERVERS}/${URL_ID}`, onWork);

    expect(answer.body).toMatchObject({
      id: URL_ID,
      name: "docs",
      tools,
      status: "checking",
      statusDetail: null,
      source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-work" },
    });
    expect(world.signIns.size).toBe(0);
  });

  it("refuses a plugin server, an address off the contribution's origin, a second server and an unknown contribution", async () => {
    const { send } = open([
      SENTRY_WORK,
      buildUrlServer(URL_ID, SENTRY_ADDRESS),
      buildUrlServer(OTHER_ID, TOKEN_URL),
    ]);

    const fromPlugin = await send(`PATCH ${SERVERS}/${SENTRY_WORK.id}`, onWork);
    const offOrigin = await send(`PATCH ${SERVERS}/${OTHER_ID}`, {
      source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-hobby" },
    });
    const second = await send(`PATCH ${SERVERS}/${URL_ID}`, onWork);
    const unknown = await send(`PATCH ${SERVERS}/${URL_ID}`, {
      source: { kind: "plugin", contributionId: "nobody/nobody", connectionId: "c-work" },
    });

    expect(readRefusal(fromPlugin)).toMatchObject({ status: 409, code: "invalid_state" });
    expect(readRefusal(offOrigin)).toMatchObject({
      status: 400,
      paths: ["source.contributionId"],
    });
    expect(readRefusal(second)).toMatchObject({ status: 409, reason: "mcp-server-exists" });
    expect(readRefusal(unknown)).toMatchObject({ status: 400, paths: ["source.contributionId"] });
  });
});

describe("mcpServer.setToken", () => {
  it("refuses a token the contract refuses, and a plugin server", async () => {
    const { send } = open([SENTRY_WORK, buildUrlServer(URL_ID, TOKEN_URL)]);

    expect(
      readRefusal(await send(`POST ${SERVERS}/${URL_ID}/token`, { token: "short" })),
    ).toMatchObject({ status: 400, paths: ["token"] });
    expect(
      readRefusal(
        await send(`POST ${SERVERS}/${SENTRY_WORK.id}/token`, { token: "long-enough-1" }),
      ),
    ).toMatchObject({ status: 409, code: "invalid_state" });
  });

  it("records the token, ends a waiting browser sign-in, and sets the sign-in to token", async () => {
    const { send, world } = open([buildUrlServer(URL_ID, TOKEN_URL, { status: "needs-sign-in" })]);
    await send(`POST ${SERVERS}/${URL_ID}/sign-in`, { redirectUri: REDIRECT });

    const answer = await send(`POST ${SERVERS}/${URL_ID}/token`, { token: "long-enough-1" });

    expect(answer.body).toMatchObject({
      status: "checking",
      statusDetail: null,
      source: { signIn: "token" },
    });
    expect(world.tokens).toEqual([{ id: URL_ID, token: "long-enough-1" }]);
    expect(world.signIns.size).toBe(0);
  });
});

describe("the browser sign-in", () => {
  const start = async (send: ReturnType<typeof open>["send"], world: McpWorld, id = URL_ID) => {
    const answer = await send(`POST ${SERVERS}/${id}/sign-in`, { redirectUri: REDIRECT });
    return { answer, attempt: world.signIns.get(id)! };
  };
  const finish = (send: ReturnType<typeof open>["send"], callbackQuery: string, id = URL_ID) =>
    send(`POST ${SERVERS}/${id}/sign-in/finish`, { callbackQuery });

  it("starts with an authorization address that carries the state, and expires in ten minutes", async () => {
    const { send, world } = open([buildUrlServer(URL_ID, TOKEN_URL)]);
    const before = Date.now();

    const { answer, attempt } = await start(send, world);

    const { authorizationUrl, expiresAt } = answer.body as {
      authorizationUrl: string;
      expiresAt: string;
    };
    expect(readAuthorizationState(authorizationUrl)).toBe(attempt.state);
    expect(new URL(authorizationUrl).host).toBe("auth.docs.acme.example");
    expect(Date.parse(expiresAt) - before).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(Date.parse(expiresAt) - before).toBeLessThan(10 * 60 * 1000 + 5000);
  });

  it("refuses a bad redirect address, a plugin server, and a server that offers only a token", async () => {
    const { send } = open([
      SENTRY_WORK,
      buildUrlServer(URL_ID, TOKEN_URL),
      buildUrlServer(OTHER_ID, "https://tokens.example/mcp", {
        source: {
          kind: "url",
          url: "https://tokens.example/mcp",
          signIn: "none",
          signInOffered: "token",
        },
      }),
    ]);
    const startOn = (id: string, redirectUri = REDIRECT) =>
      send(`POST ${SERVERS}/${id}/sign-in`, { redirectUri });

    expect(readRefusal(await startOn(URL_ID, "http://localhost:1/callback"))).toMatchObject({
      status: 400,
      paths: ["redirectUri"],
    });
    expect(readRefusal(await startOn(SENTRY_WORK.id))).toMatchObject({
      status: 409,
      code: "invalid_state",
    });
    expect(readRefusal(await startOn(OTHER_ID))).toMatchObject({
      status: 409,
      reason: "sign-in-unsupported",
    });
  });

  it("finishes with the state of the attempt, as a query or as the whole address, and signs the server in", async () => {
    for (const build of [
      (state: string) => `code=c&state=${state}`,
      (state: string) => `${REDIRECT}?code=c&state=${state}#done`,
    ]) {
      const { send, world } = open([
        buildUrlServer(URL_ID, TOKEN_URL, { status: "needs-sign-in" }),
      ]);
      const { attempt } = await start(send, world);

      const answer = await finish(send, build(attempt.state));

      expect(answer.body).toMatchObject({
        status: "checking",
        statusDetail: null,
        source: { signIn: "oauth", signInOffered: "oauth" },
      });
      expect(world.signIns.size).toBe(0);
    }
  });

  it("answers sign-in-expired for another state, for an attempt that ran out, for a second answer and for a replaced attempt", async () => {
    const { send, world } = open([buildUrlServer(URL_ID, TOKEN_URL)]);
    const expired = (answer: Answer) => readRefusal(answer);

    const { attempt: first } = await start(send, world);
    expect(expired(await finish(send, "code=c&state=another"))).toMatchObject({
      status: 409,
      reason: "sign-in-expired",
    });

    world.signIns.set(URL_ID, { ...first, expiresAtMillis: Date.now() - 1 });
    expect(expired(await finish(send, `code=c&state=${first.state}`))).toMatchObject({
      reason: "sign-in-expired",
    });

    const { attempt: second } = await start(send, world);
    const { attempt: third } = await start(send, world);
    expect(second.state).not.toBe(third.state);
    expect(expired(await finish(send, `code=c&state=${second.state}`))).toMatchObject({
      reason: "sign-in-expired",
    });
    expect((await finish(send, `code=c&state=${third.state}`)).status).toBeUndefined();
    expect(expired(await finish(send, `code=c&state=${third.state}`))).toMatchObject({
      reason: "sign-in-expired",
    });
  });

  it("refuses text that is not a redirect answer, and an address that is not the redirect address, and keeps the attempt", async () => {
    const { send, world } = open([buildUrlServer(URL_ID, TOKEN_URL)]);
    const { attempt } = await start(send, world);

    expect(readRefusal(await finish(send, "code=c"))).toMatchObject({
      status: 400,
      paths: ["callbackQuery"],
    });
    expect(
      readRefusal(
        await finish(send, `http://127.0.0.1:9999/callback?code=c&state=${attempt.state}`),
      ),
    ).toMatchObject({ status: 400, paths: ["callbackQuery"] });
    expect(world.signIns.get(URL_ID)).toBe(attempt);
  });

  it("answers sign-in-refused for an error from the authorization server, and uses the attempt up", async () => {
    const { send, world } = open([buildUrlServer(URL_ID, TOKEN_URL)]);
    const { attempt } = await start(send, world);

    const refusal = readRefusal(await finish(send, `error=access_denied&state=${attempt.state}`));

    expect(refusal).toMatchObject({ status: 409, reason: "sign-in-refused" });
    expect(refusal.message).toContain("(access_denied)");
    expect(world.signIns.size).toBe(0);
  });
});
