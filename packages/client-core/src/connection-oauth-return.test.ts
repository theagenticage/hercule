import { describe, expect, it, vi } from "vitest";
import { buildErrorBody, createApiStub, type Answer } from "./api-stub";
import { createClient } from "./client";
import {
  decideOAuthReturnPath,
  readClientValues,
  readFinishFailure,
  readPastedReturn,
  readTypedValue,
  startLocalReturnSignIn,
} from "./connection-oauth-return";
import type { ConnectionType } from "./connection-types";
import { ApiError, ConnectionError } from "./errors";
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

  it("reads a field named like an inherited property as an ordinary key", () => {
    const odd = buildType({
      clientSetupFields: [
        { name: "constructor", label: "Constructor" },
        { name: "__proto__", label: "Prototype" },
        { name: "toString", label: "To string" },
      ],
    });
    // Nothing typed: the inherited functions are no input, and nothing throws.
    expect(readClientValues(odd, {})).toBeUndefined();

    const typed = Object.fromEntries([
      ["constructor", "a"],
      ["__proto__", "b"],
      ["toString", "c"],
    ]) as Record<string, string>;
    const values = readClientValues(odd, typed);
    expect(Object.keys(values ?? {})).toEqual(["constructor", "__proto__", "toString"]);
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(JSON.stringify(values)).toBe('{"constructor":"a","__proto__":"b","toString":"c"}');
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
  const live = new AbortController().signal;

  it("sends the listener's address as the redirect, with the client values, and waits for the return", async () => {
    const port = buildPort({ kind: "received", callbackQuery: "code=c&state=s1" });
    const { host, calls } = buildHost(port);

    const signIn = await startLocalReturnSignIn(
      host,
      { type: "slack/slack", clientValues: { configurationToken: "not-a-real-token" } },
      live,
    );

    expect(calls.map((call) => call.body)).toEqual([
      {
        type: "slack/slack",
        clientValues: { configurationToken: "not-a-real-token" },
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

  it("opens the provider's page through the port, which reports a refusal", async () => {
    const port = buildPort({ kind: "cancelled" });
    const signIn = await startLocalReturnSignIn(
      buildHost(port).host,
      { type: "slack/slack" },
      live,
    );
    await signIn.openPage();
    expect(port.open).toHaveBeenCalledWith(AUTHORIZATION_URL);

    port.open.mockRejectedValueOnce(new Error("No browser is set."));
    await expect(signIn.openPage()).rejects.toThrow("No browser is set.");
  });

  it("sends a reconnect's Connection, and no client values when it has none", async () => {
    const { host, calls } = buildHost(buildPort({ kind: "cancelled" }));
    await startLocalReturnSignIn(
      host,
      { type: "slack/slack", connectionId: "01a06d02-7700-7000-8000-000000000002" },
      live,
    );
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
      const signIn = await startLocalReturnSignIn(host, { type: "slack/slack" }, live);
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
      live,
    );
    expect(await timedOut.awaitReturn()).toEqual({
      kind: "stopped",
      message: "The browser did not come back within 10 minutes. Start again.",
    });
    const broken = await startLocalReturnSignIn(
      buildHost(buildPort(new Error("The window went away."))).host,
      { type: "slack/slack" },
      live,
    );
    expect(await broken.awaitReturn()).toEqual({
      kind: "stopped",
      message: "The window went away.",
    });
  });

  it("closes the listener once when the attempt aborts, and waits no more", async () => {
    const port = buildPort({ kind: "cancelled" });
    const attempt = new AbortController();
    const signIn = await startLocalReturnSignIn(
      buildHost(port).host,
      { type: "slack/slack" },
      attempt.signal,
    );
    attempt.abort();
    attempt.abort();
    expect(port.cancel).toHaveBeenCalledTimes(1);
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect((await signIn.awaitReturn()).kind).toBe("stopped");
    expect(port.wait).not.toHaveBeenCalled();
  });

  it("closes the listener when the attempt aborts before the controller answers the start", async () => {
    const port = buildPort({ kind: "cancelled" });
    const attempt = new AbortController();
    let answerStart: (answer: Answer) => void = () => undefined;
    const api = createApiStub({
      "POST /api/v1/oauth/start": () =>
        new Promise<Answer>((resolve) => {
          answerStart = resolve;
        }),
    });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });
    const started = startLocalReturnSignIn(
      { client, port },
      { type: "slack/slack" },
      attempt.signal,
    );
    await vi.waitFor(() => {
      expect(api.calls).toHaveLength(1);
    });

    attempt.abort();
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    answerStart({ body: { authorizationUrl: AUTHORIZATION_URL } });

    await expect(started).rejects.toThrow();
    expect(port.cancel).toHaveBeenCalledTimes(1);
  });

  it("closes the listener when the attempt aborts while the port starts listening", async () => {
    const attempt = new AbortController();
    let listened: (outcome: Awaited<ReturnType<BrowserSignInPort["listen"]>>) => void = () =>
      undefined;
    const port = buildPort(
      { kind: "cancelled" },
      () =>
        new Promise((resolve) => {
          listened = resolve;
        }),
    );
    const { host, calls } = buildHost(port);
    const started = startLocalReturnSignIn(host, { type: "slack/slack" }, attempt.signal);
    attempt.abort();
    listened(LISTENING);

    await expect(started).rejects.toThrow();
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect(calls).toHaveLength(0);
  });

  it("closes the listener and fails with the controller's message when the start is refused", async () => {
    const port = buildPort({ kind: "cancelled" });
    const { host } = buildHost(port, {
      status: 400,
      body: buildErrorBody("validation", "This configuration token has expired. Make a new one."),
    });
    await expect(startLocalReturnSignIn(host, { type: "slack/slack" }, live)).rejects.toThrow(
      "This configuration token has expired. Make a new one.",
    );
    expect(port.cancel).toHaveBeenCalledWith("l-1");
  });
});

describe("readPastedReturn", () => {
  const OWN_URL = "https://slack.example/authorize?client_id=c&state=own-state";

  it("returns the address, trimmed, for the sign-in it was started for", () => {
    const address = "http://127.0.0.1:51234/callback?code=c-1&state=own-state";
    expect(readPastedReturn(OWN_URL, `  ${address}\n`)).toEqual({
      kind: "callback",
      callbackQuery: address,
    });
    expect(readPastedReturn(OWN_URL, "?code=c-1&state=own-state")).toEqual({
      kind: "callback",
      callbackQuery: "?code=c-1&state=own-state",
    });
  });

  it("refuses an address from another sign-in, which the controller would complete in place of this one", () => {
    expect(
      readPastedReturn(OWN_URL, "http://127.0.0.1:51234/callback?code=c-1&state=other-state"),
    ).toEqual({
      kind: "refused",
      message:
        "This address is from another sign-in: paste the address the browser ended on for this one.",
    });
  });

  it("refuses text that is not a redirect answer, in the parser's words", () => {
    const reading = readPastedReturn(OWN_URL, "not an address");
    expect(reading.kind).toBe("refused");
    expect((reading as { message: string }).message).toContain(
      "That is not what the browser ended on",
    );
  });
});

describe("readTypedValue", () => {
  it("returns what was typed for a name, an empty string for none, and no inherited property", () => {
    const typed = Object.fromEntries([["token", "abc"]]) as Record<string, string>;
    expect(readTypedValue(typed, "token")).toBe("abc");
    expect(readTypedValue(typed, "other")).toBe("");
    expect(readTypedValue(typed, "constructor")).toBe("");
    expect(readTypedValue(typed, "__proto__")).toBe("");
  });
});

describe("readFinishFailure", () => {
  it("leaves the sign-in open when the controller did not answer, or failed", () => {
    expect(
      readFinishFailure(new ConnectionError("http://127.0.0.1:4937", new Error("down"))),
    ).toEqual({
      kind: "retry",
      message: "The controller could not be reached, so the sign-in is not finished. Try again.",
    });
    expect(readFinishFailure(new ApiError("internal", "boom"))).toEqual({
      kind: "retry",
      message: "The controller failed while finishing the sign-in. Try again.",
    });
  });

  it("ends the sign-in on an answer of the controller, in the controller's words", () => {
    expect(readFinishFailure(new ApiError("invalid_state", "Slack refused the code."))).toEqual({
      kind: "refused",
      message: "Slack refused the code.",
    });
    expect(readFinishFailure(new ApiError("validation", "Not a redirect answer."))).toEqual({
      kind: "refused",
      message: "Not a redirect answer.",
    });
  });
});
