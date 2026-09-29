/**
 * Test helpers that run the real renderer against a fake bridge and a stubbed
 * controller.
 *
 * Only the two edges are replaced: `window.bridge`, which main provides, and
 * the global `fetch`, which reaches the controller. Boot's context, the
 * client, the router, the entry guard and the screens are the ones that ship,
 * so a change to any of them shows up in the tests.
 */
import { afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import type { Bridge } from "../../ipc/bridge";
import type { ControllerUrlSaveOutcome } from "../../ipc/contract";
import { buildRouterContext, type RouterContext } from "./context";
import { createAppRouter } from "./router";

/** The address of the stubbed controller. */
export const CONTROLLER_URL = "http://controller.test";

/** The bridge a test passes to the app, and what the app did with it. */
export interface FakeBridge {
  readonly bridge: Bridge;
  /** The tokens the app sent main to store, oldest first. `null` is a removal. */
  readonly tokenWrites: readonly (string | null)[];
  /** The addresses the app asked main to check and save, oldest first. */
  readonly savedUrls: readonly string[];
  /** Sends the Sign Out menu command, as main does when the user picks the menu item. */
  readonly sendSignOut: () => void;
}

/**
 * Creates a bridge that answers as main would for a user whose settings hold
 * `controllerUrl` and whose Keychain holds `token`. `save` answers each
 * Connect; by default the controller checks out and the URL is saved.
 */
export const createFakeBridge = ({
  controllerUrl = null,
  token = null,
  save = (url) => Promise.resolve({ _tag: "Saved", origin: url }),
}: {
  readonly controllerUrl?: string | null;
  readonly token?: string | null;
  readonly save?: (url: string) => Promise<ControllerUrlSaveOutcome>;
} = {}): FakeBridge => {
  const tokenWrites: (string | null)[] = [];
  const savedUrls: string[] = [];
  const menuListeners = new Set<(command: "signOut") => void>();
  return {
    bridge: {
      controllerUrl: {
        read: () => Promise.resolve(controllerUrl),
        save: (url) => {
          savedUrls.push(url);
          return save(url);
        },
      },
      token: {
        read: () => Promise.resolve(token),
        write: (next) => {
          tokenWrites.push(next);
          return Promise.resolve(undefined);
        },
      },
      menu: {
        onCommand: (listener) => {
          menuListeners.add(listener);
          return () => menuListeners.delete(listener);
        },
      },
    },
    tokenWrites,
    savedUrls,
    sendSignOut: () => {
      // Main sends the command from outside React, so the updates it causes
      // are wrapped in `act`, which applies them before the test goes on.
      act(() => {
        for (const listener of menuListeners) listener("signOut");
      });
    },
  };
};

/** One request the app sent the controller, as the stub received it. */
export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** The `authorization` header, or `null` when the request had none. */
  readonly authorization: string | null;
}

/** The response a stubbed operation returns. */
export interface Answer {
  readonly status?: number;
  readonly body: unknown;
}

/**
 * The response for one operation, or a function that builds it. A function
 * that throws or rejects makes `fetch` reject, as it does when the controller
 * cannot be reached.
 */
export type Handler = Answer | ((call: Call) => Answer | Promise<Answer>);

/** Builds the error body the API sends. */
export const buildErrorBody = (code: string, message: string): { error: unknown } => ({
  error: { code, message },
});

/** The error `fetch` rejects with when nothing answers at the address. */
export const refuseConnection = (): never => {
  throw new TypeError("Failed to fetch");
};

/**
 * Answers never, like a controller that accepts the connection and then
 * hangs. The request still ends when its signal aborts, as a real one does.
 */
export const neverAnswer = (): Promise<Answer> => new Promise(() => {});

/** Returns a promise that rejects with the signal's reason when `signal` aborts, as `fetch` does. */
const rejectOnAbort = (signal: AbortSignal | null | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        // Every abort in the app passes an Error as its reason, such as the
        // TimeoutError of `fetchWithTimeout`.
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

/**
 * Stubs the global `fetch` for this test with one that responds from
 * `handlers`, keyed `METHOD /path`, and returns the calls it receives.
 *
 * `GET /api/v1/setup` answers that setup is complete unless a handler says
 * otherwise, because the entry guard reads it on every start. Any other
 * unstubbed path returns 404, so a test that forgot a route notices.
 */
export const stubApi = (handlers: Readonly<Record<string, Handler>> = {}): readonly Call[] => {
  const calls: Call[] = [];
  const withDefaults: Readonly<Record<string, Handler>> = {
    "GET /api/v1/setup": { body: { complete: true } },
    ...handlers,
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    const sent = await request.text();
    const call: Call = {
      method: request.method,
      path: new URL(url).pathname,
      body: sent.length === 0 ? undefined : JSON.parse(sent),
      authorization: request.headers.get("authorization"),
    };
    calls.push(call);
    const handler = withDefaults[`${call.method} ${call.path}`];
    const answer: Answer =
      handler === undefined
        ? {
            status: 404,
            body: buildErrorBody("not_found", `no stub for ${call.method} ${call.path}`),
          }
        : typeof handler === "function"
          ? await Promise.race([handler(call), rejectOnAbort(init?.signal)])
          : handler;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Boots the app the way `main.tsx` does, with `fake` as the bridge, and
 * renders it at once, while the first navigation is still running. For a test
 * of what the window shows while the entry guard waits. Stub the API with
 * `stubApi` first. Returns the router and its context.
 */
export const startApp = async (
  fake: FakeBridge,
): Promise<{
  readonly router: ReturnType<typeof createAppRouter>;
  readonly context: RouterContext;
}> => {
  const context = await buildRouterContext(fake.bridge);
  const router = createAppRouter(context);
  render(<RouterProvider router={router} />);
  return { router, context };
};

/**
 * Boots the app the way `main.tsx` does, with `fake` as the bridge, and
 * renders it once the first navigation, entry guard included, has settled.
 * Stub the API with `stubApi` first. Returns the router and its context.
 */
export const renderApp = async (
  fake: FakeBridge,
): Promise<{
  readonly router: ReturnType<typeof createAppRouter>;
  readonly context: RouterContext;
}> => {
  const context = await buildRouterContext(fake.bridge);
  const router = createAppRouter(context);
  await router.load();
  render(<RouterProvider router={router} />);
  return { router, context };
};
