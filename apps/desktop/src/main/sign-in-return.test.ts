import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  AuthorizationUrlHasNoState,
  cancelWhenPageEnds,
  makeSignInReturnLayer,
  SIGN_IN_RETURN_LIFETIME_MILLISECONDS,
  SignInReturn,
  type PageEvents,
} from "./sign-in-return";

/** The scopes of the services these tests built; each test's service lives until the test ends. */
const openScopes: Array<Scope.Closeable> = [];

afterEach(async () => {
  for (const scope of openScopes.splice(0)) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

/**
 * Builds the service with listeners that last `lifetimeMilliseconds`, and
 * returns it. Closing the scope is what quitting the app does.
 */
const openService = async (
  lifetimeMilliseconds: number = SIGN_IN_RETURN_LIFETIME_MILLISECONDS,
): Promise<{ service: SignInReturn["Service"]; quit: () => Promise<void> }> => {
  const scope = await Effect.runPromise(Scope.make());
  openScopes.push(scope);
  const context = await Effect.runPromise(
    Layer.buildWithScope(makeSignInReturnLayer(lifetimeMilliseconds), scope),
  );
  return {
    service: Context.get(context, SignInReturn),
    quit: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

/** Starts a listener and returns its id and the address of its redirect URI. */
const listenOn = async (service: SignInReturn["Service"]) => {
  const outcome = await Effect.runPromise(service.listen);
  if (outcome._tag !== "listening") throw new Error("the listener could not start");
  return { listenerId: outcome.listenerId, redirectUri: outcome.redirectUri };
};

/** Starts waiting for the sign-in with this `state`; the promise answers when the wait ends. */
const waitFor = (service: SignInReturn["Service"], listenerId: string, state: string) =>
  Effect.runPromise(service.wait(listenerId, `https://mcp.example/authorize?state=${state}`));

/** Reports whether something still accepts connections at `address`. */
const isListening = (address: string): Promise<boolean> =>
  fetch(address).then(
    () => true,
    () => false,
  );

describe("the redirect URI", () => {
  it("is on 127.0.0.1, on a port main picked, at /callback", async () => {
    const { service } = await openService();
    const { redirectUri } = await listenOn(service);
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });
});

describe("the browser's return", () => {
  it("answers received with the raw query when the state matches, and closes the port", async () => {
    const { service } = await openService();
    const { listenerId, redirectUri } = await listenOn(service);
    const waiting = waitFor(service, listenerId, "s1");

    const page = await fetch(`${redirectUri}?code=a%20b%2B&state=s1`);

    expect(await waiting).toEqual({ _tag: "received", callbackQuery: "code=a%20b%2B&state=s1" });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await page.text();
    expect(body).toContain("You can close this tab and return to Hercule.");
    expect(body).not.toContain("Signed in");
    expect(body).not.toContain("<script");
    expect(await isListening(redirectUri)).toBe(false);
  });

  it("answers 404 to a stray path, a wrong method and a wrong state, and goes on waiting", async () => {
    const { service } = await openService();
    const { listenerId, redirectUri } = await listenOn(service);
    const waiting = waitFor(service, listenerId, "s1");
    let ended = false;
    void waiting.then(() => {
      ended = true;
    });

    const origin = new URL(redirectUri).origin;
    const strays = [
      await fetch(`${origin}/`),
      await fetch(`${origin}/favicon.ico`),
      await fetch(`${origin}/callback/more?state=s1`),
      await fetch(`${redirectUri}?code=a`),
      await fetch(`${redirectUri}?code=a&state=s2`),
      await fetch(`${redirectUri}?code=a&state=s1`, { method: "POST" }),
    ];
    expect(strays.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
    await Promise.all(strays.map((response) => response.text()));
    expect(ended).toBe(false);

    await fetch(`${redirectUri}?code=a&state=s1`);
    expect(await waiting).toEqual({ _tag: "received", callbackQuery: "code=a&state=s1" });
  });

  it("answers 404 to a return the parser refuses, and goes on waiting", async () => {
    const { service } = await openService();
    const { listenerId, redirectUri } = await listenOn(service);
    const waiting = waitFor(service, listenerId, "s1");
    let ended = false;
    void waiting.then(() => {
      ended = true;
    });

    // Which returns the parser refuses has its own tests in the contract.
    const response = await fetch(`${redirectUri}?state=s1&code=a&error=access_denied`);
    await response.text();
    expect(response.status).toBe(404);
    expect(ended).toBe(false);

    await fetch(`${redirectUri}?error=access_denied&state=s1`);
    expect(await waiting).toEqual({
      _tag: "received",
      callbackQuery: "error=access_denied&state=s1",
    });
  });

  it("answers 404 before any wait names the state", async () => {
    const { service } = await openService();
    const { listenerId, redirectUri } = await listenOn(service);

    expect((await fetch(`${redirectUri}?code=a&state=s1`)).status).toBe(404);

    const waiting = waitFor(service, listenerId, "s1");
    await fetch(`${redirectUri}?code=a&state=s1`);
    expect(await waiting).toEqual({ _tag: "received", callbackQuery: "code=a&state=s1" });
  });
});

describe("cancelling", () => {
  it("answers the pending wait cancelled and closes the port", async () => {
    const { service } = await openService();
    const { listenerId, redirectUri } = await listenOn(service);
    const waiting = waitFor(service, listenerId, "s1");

    await Effect.runPromise(service.cancel(listenerId));

    expect(await waiting).toEqual({ _tag: "cancelled" });
    expect(await isListening(redirectUri)).toBe(false);
  });

  it("does nothing for a listener main does not have", async () => {
    const { service } = await openService();
    const { listenerId, redirectUri } = await listenOn(service);

    await Effect.runPromise(service.cancel("not-a-listener"));

    expect(await isListening(redirectUri)).toBe(true);
    await Effect.runPromise(service.cancel(listenerId));
  });

  it("answers a wait on an unknown listener cancelled", async () => {
    const { service } = await openService();
    expect(await waitFor(service, "not-a-listener", "s1")).toEqual({ _tag: "cancelled" });
  });

  it("is what a second listen does to the first listener", async () => {
    const { service } = await openService();
    const first = await listenOn(service);
    const firstWaiting = waitFor(service, first.listenerId, "s1");

    const second = await listenOn(service);

    expect(await firstWaiting).toEqual({ _tag: "cancelled" });
    expect(await isListening(first.redirectUri)).toBe(false);
    expect(second.listenerId).not.toBe(first.listenerId);
    const secondWaiting = waitFor(service, second.listenerId, "s2");
    await fetch(`${second.redirectUri}?code=a&state=s2`);
    expect(await secondWaiting).toEqual({ _tag: "received", callbackQuery: "code=a&state=s2" });
  });

  it("is what quitting the app does to the listener", async () => {
    const { service, quit } = await openService();
    const { listenerId, redirectUri } = await listenOn(service);
    const waiting = waitFor(service, listenerId, "s1");

    await quit();

    expect(await waiting).toEqual({ _tag: "cancelled" });
    expect(await isListening(redirectUri)).toBe(false);
  });
});

describe("the time limit", () => {
  it("closes the port when the browser does not return in time, and no one waits", async () => {
    const { service } = await openService(50);
    const { redirectUri } = await listenOn(service);
    expect(await isListening(redirectUri)).toBe(true);

    // The listener closes by itself when its time limit passes.
    await vi.waitFor(async () => expect(await isListening(redirectUri)).toBe(false));
  });

  it("answers timed-out when the browser does not return in time, and closes the port", async () => {
    const { service } = await openService(50);
    const { listenerId, redirectUri } = await listenOn(service);

    expect(await waitFor(service, listenerId, "s1")).toEqual({ _tag: "timed-out" });
    expect(await isListening(redirectUri)).toBe(false);
  });
});

describe("a page that ends", () => {
  /** A page whose events a test emits, as Electron's `WebContents` would. */
  const openPage = () => {
    const page = new EventEmitter();
    const cancel = vi.fn();
    cancelWhenPageEnds(page as unknown as PageEvents, cancel);
    return { page, cancel };
  };

  it("cancels the listener when the page is destroyed or its renderer process is gone", () => {
    const destroyed = openPage();
    destroyed.page.emit("destroyed");
    const gone = openPage();
    gone.page.emit("render-process-gone");

    expect(destroyed.cancel).toHaveBeenCalledTimes(1);
    expect(gone.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels the listener when the main frame navigates to another document, and not otherwise", () => {
    const { page, cancel } = openPage();

    page.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    page.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(cancel).not.toHaveBeenCalled();

    page.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("ending the current listener", () => {
  it("closes the port of the listener there is, and does nothing when there is none", async () => {
    const { service } = await openService();
    await Effect.runPromise(service.cancelCurrent);
    const { listenerId, redirectUri } = await listenOn(service);
    const waiting = waitFor(service, listenerId, "s1");

    await Effect.runPromise(service.cancelCurrent);

    expect(await waiting).toEqual({ _tag: "cancelled" });
    expect(await isListening(redirectUri)).toBe(false);
  });
});

describe("an authorization URL with no state", () => {
  it("is refused, because no return could match it", async () => {
    const { service } = await openService();
    const { listenerId } = await listenOn(service);

    const error = await Effect.runPromise(
      Effect.flip(service.wait(listenerId, "https://mcp.example/authorize?client_id=x")),
    );

    expect(error).toBeInstanceOf(AuthorizationUrlHasNoState);
  });
});
