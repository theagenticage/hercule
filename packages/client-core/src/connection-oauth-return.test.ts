import { describe, expect, it, vi } from "vitest";
import { buildErrorBody, createApiStub, type Answer } from "./api-stub";
import { createClient } from "./client";
import {
  decideOAuthReturnPath,
  readClientValues,
  startLocalReturnSignIn,
} from "./connection-oauth-return";
import type { ConnectionType } from "./connection-types";
import type { BrowserSignInPort } from "./mcp-servers/browser-sign-in";

const buildType = (overrides: Partial<ConnectionType>): ConnectionType => ({
  type: "p/t",
  displayName: "T",
  pluginName: "P",
  setup: [{ kind: "oauth" }],
  hasPublicClient: false,
  clientSetupFields: [],
  registeredRedirectUris: [],
  feeds: [],
  ...overrides,
});

/** A type like Slack: its client is created at setup and registers loopback addresses without a port. */
const CREATED_CLIENT = buildType({
  hasPublicClient: true,
  clientSetupFields: [{ name: "configurationToken", label: "Configuration token" }],
  registeredRedirectUris: [
    "http://127.0.0.1/oauth/callback",
    "http://localhost/oauth/callback",
    "http://127.0.0.1/callback",
  ],
});

/** A type like Linear: a shipped client that registered the controller's callback at one port. */
const SHIPPED_CLIENT = buildType({
  hasPublicClient: true,
  registeredRedirectUris: [
    "http://127.0.0.1:4937/oauth/callback",
    "http://localhost:4937/oauth/callback",
  ],
});

/** A type like Google: no public client, so the plugin's own client and the controller's callback. */
const OWN_CLIENT = buildType({});

describe("decideOAuthReturnPath", () => {
  it("catches the return on the machine in the desktop app, for a client that registered the loopback callback", () => {
    expect(decideOAuthReturnPath(CREATED_CLIENT, "desktop")).toBe("local-listener");
  });

  it("keeps the controller's callback in the desktop app for every other type", () => {
    expect(decideOAuthReturnPath(SHIPPED_CLIENT, "desktop")).toBe("controller-callback");
    expect(decideOAuthReturnPath(OWN_CLIENT, "desktop")).toBe("controller-callback");
  });

  it("asks the web app's user to paste the address, also when the page is at a loopback origin", () => {
    expect(decideOAuthReturnPath(CREATED_CLIENT, "web")).toBe("pasted-address");
  });

  it("keeps the controller's callback in the web app for a type with no loopback callback", () => {
    expect(decideOAuthReturnPath(SHIPPED_CLIENT, "web")).toBe("controller-callback");
    expect(decideOAuthReturnPath(OWN_CLIENT, "web")).toBe("controller-callback");
  });
});

describe("readClientValues", () => {
  it("returns one value for each field the type declares, and nothing else typed", () => {
    expect(
      readClientValues(CREATED_CLIENT, { configurationToken: "xoxe.xoxp-1", stale: "x" }),
    ).toEqual({ configurationToken: "xoxe.xoxp-1" });
  });

  it("returns nothing while a value is blank", () => {
    expect(readClientValues(CREATED_CLIENT, {})).toBeUndefined();
    expect(readClientValues(CREATED_CLIENT, { configurationToken: "  " })).toBeUndefined();
  });

  it("returns nothing for a type whose client is not created at setup", () => {
    expect(readClientValues(OWN_CLIENT, { configurationToken: "x" })).toBeUndefined();
  });
});

describe("startLocalReturnSignIn", () => {
  const AUTHORIZATION_URL = "https://slack.example/authorize?state=s1";
  const LISTENING = {
    kind: "listening" as const,
    listenerId: "l-1",
    redirectUri: "http://127.0.0.1:51234/callback",
  };

  /** A port whose listener answers `wait` with `outcome`, or fails it with an error. */
  const buildPort = (
    outcome: Awaited<ReturnType<BrowserSignInPort["wait"]>> | Error,
    listen: BrowserSignInPort["listen"] = () => Promise.resolve(LISTENING),
  ) => ({
    listen,
    wait: vi.fn((): ReturnType<BrowserSignInPort["wait"]> =>
      outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
    ),
    cancel: vi.fn((): Promise<void> => Promise.resolve()),
    open: vi.fn((): Promise<void> => Promise.resolve()),
  });

  const buildHost = (port: BrowserSignInPort | undefined, answer?: Answer) => {
    const api = createApiStub({
      "POST /api/v1/oauth/start": answer ?? { body: { authorizationUrl: AUTHORIZATION_URL } },
    });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });
    return { host: { client, port }, calls: api.calls };
  };

  it("sends the listener's address as the redirect, with the client values, and waits for the return", async () => {
    const port = buildPort({ kind: "received", callbackQuery: "code=c&state=s1" });
    const { host, calls } = buildHost(port);

    const signIn = await startLocalReturnSignIn(host, {
      type: "slack/slack",
      clientValues: { configurationToken: "xoxe.xoxp-1" },
    });

    expect(calls.map((call) => call.body)).toEqual([
      {
        type: "slack/slack",
        clientValues: { configurationToken: "xoxe.xoxp-1" },
        redirectUri: "http://127.0.0.1:51234/callback",
      },
    ]);
    expect(signIn.returnBy).toBe("listener");
    expect(signIn.authorizationUrl).toBe(AUTHORIZATION_URL);
    expect(await signIn.awaitReturn()).toEqual({
      kind: "received",
      callbackQuery: "code=c&state=s1",
    });
    expect(port.wait).toHaveBeenCalledWith("l-1", AUTHORIZATION_URL);
  });

  it("sends a reconnect's Connection, and no client values when it has none", async () => {
    const { host, calls } = buildHost(buildPort({ kind: "cancelled" }));
    await startLocalReturnSignIn(host, {
      type: "slack/slack",
      connectionId: "01a06d02-7700-7000-8000-000000000002",
    });
    expect(calls[0]?.body).toEqual({
      type: "slack/slack",
      connectionId: "01a06d02-7700-7000-8000-000000000002",
      redirectUri: "http://127.0.0.1:51234/callback",
    });
  });

  it("asks for a pasted address when the app cannot listen, and when it has no port", async () => {
    const cannotListen = buildPort({ kind: "cancelled" }, () =>
      Promise.resolve({ kind: "unavailable" }),
    );
    for (const port of [cannotListen, undefined]) {
      const { host, calls } = buildHost(port);
      const signIn = await startLocalReturnSignIn(host, { type: "slack/slack" });
      expect(signIn.returnBy).toBe("paste");
      expect((calls[0]?.body as { redirectUri: string }).redirectUri).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
      );
      expect(await signIn.awaitReturn()).toEqual({
        kind: "stopped",
        message: "The app stopped waiting for the browser. Start again.",
      });
    }
  });

  it("says when the browser did not come back in time, and when the wait broke", async () => {
    const timedOut = await startLocalReturnSignIn(
      buildHost(buildPort({ kind: "timed-out" })).host,
      { type: "slack/slack" },
    );
    expect(await timedOut.awaitReturn()).toEqual({
      kind: "stopped",
      message: "The browser did not come back within 10 minutes. Start again.",
    });
    const broken = await startLocalReturnSignIn(
      buildHost(buildPort(new Error("The window went away."))).host,
      { type: "slack/slack" },
    );
    expect(await broken.awaitReturn()).toEqual({
      kind: "stopped",
      message: "The window went away.",
    });
  });

  it("closes the listener once, however often close is called", async () => {
    const port = buildPort({ kind: "cancelled" });
    const signIn = await startLocalReturnSignIn(buildHost(port).host, { type: "slack/slack" });
    signIn.close();
    signIn.close();
    expect(port.cancel).toHaveBeenCalledTimes(1);
    expect(port.cancel).toHaveBeenCalledWith("l-1");
  });

  it("closes the listener and fails with the controller's message when the start is refused", async () => {
    const port = buildPort({ kind: "cancelled" });
    const { host } = buildHost(port, {
      status: 400,
      body: buildErrorBody("validation", "This configuration token has expired. Make a new one."),
    });
    await expect(startLocalReturnSignIn(host, { type: "slack/slack" })).rejects.toThrow(
      "This configuration token has expired. Make a new one.",
    );
    expect(port.cancel).toHaveBeenCalledWith("l-1");
  });
});
