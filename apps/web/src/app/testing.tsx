/**
 * Test helpers that run the real app against a stubbed controller.
 *
 * The network is stubbed at `fetch` and at the `WebSocket` constructor, and
 * nowhere else: the client, the live supervisor, the router, the route files
 * and the screens are the ones that ship. So a test runs the same sequence of
 * steps a browser would, and a change to a route or to the entry guard shows
 * up in the tests rather than being hidden by a mock.
 */
import { afterEach, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient, createLive, type FetchLike, type Live } from "@hercule/client-core";
import type { Runner } from "@hercule/contract";
import { StubSocket, stubWebSocketInto } from "@hercule/client-core/testing";
import { createMemoryStorage } from "@hercule/ui/testing";
import { createAppRouter } from "./router";
import { followLiveStatus } from "./live-status";

const BASE_URL = "http://controller.test";

/** One request the app made, as the stub received it. */
export interface Call {
  readonly method: string;
  readonly path: string;
  /** The query string as sent, including the leading `?`; empty when there was none. */
  readonly search: string;
  readonly body: unknown;
  readonly token: string | null;
}

/** The response a stubbed operation returns. */
export interface Answer {
  readonly status?: number;
  readonly body: unknown;
}

/**
 * The response for one operation, or a function that builds it. A function may
 * return a promise that resolves later, which lets a test keep one write
 * pending while it makes another.
 */
export type Handler = Answer | ((call: Call) => Answer | Promise<Answer>);

/** Builds the error body the API sends. Only a `validation` error includes issues. */
export const buildErrorBody = (code: string, message: string): { error: unknown } => ({
  error: {
    code,
    message,
    ...(code === "validation" ? { details: { issues: [{ path: [], message }] } } : {}),
  },
});

/**
 * The requests the app makes on its own, whatever screen is under test. A test
 * that needs a different response - for example, one that rejects the ticket -
 * stubs the route itself, and its handler takes precedence.
 */
const HOUSEKEEPING: Readonly<Record<string, Handler>> = {
  "POST /api/v1/auth/ws-ticket": { body: { ticket: "ws-ticket" } },
};

/**
 * Returns a `fetch` that responds from the given handlers, keyed
 * `METHOD /path`, and records every call. An unstubbed path returns 404, so a
 * test that forgot a route notices. The housekeeping routes above are the
 * exception, because every screen's test would otherwise have to stub them.
 */
export const stubApi = (
  handlers: Readonly<Record<string, Handler>>,
): { readonly fetch: FetchLike; readonly calls: readonly Call[] } => {
  const calls: Call[] = [];

  const fetch: FetchLike = async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    // The body may arrive as a stream rather than a string, so read it the way
    // the controller does.
    const sent = await new Request(url, init).text();
    const call: Call = {
      method: init?.method ?? "GET",
      path: new URL(url).pathname,
      search: new URL(url).search,
      body: sent.length === 0 ? undefined : JSON.parse(sent),
      token: authorization === null ? null : authorization.replace(/^Bearer /, ""),
    };
    calls.push(call);

    const key = `${call.method} ${call.path}`;
    const handler = handlers[key] ?? HOUSEKEEPING[key];
    const answer: Answer =
      handler === undefined
        ? {
            status: 404,
            body: buildErrorBody("not_found", `no stub for ${call.method} ${call.path}`),
          }
        : typeof handler === "function"
          ? await handler(call)
          : handler;

    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch, calls };
};

/**
 * The live connection as a test sees it: the topics the app subscribes to, and
 * ways to send it pushes and failures. The stub socket handles the wire
 * framing.
 */
export interface LiveStub {
  /** The topics the app is subscribed to right now, oldest first. */
  topics(): readonly string[];
  /** Whether the app has a socket open. */
  connected(): boolean;
  /**
   * Delivers one message on the app's subscription to `topic`, in the shape
   * the contract defines: `{ _tag: "invalidate", ids, kind }` for a mutable
   * topic. Throws if nothing is subscribed to `topic`.
   */
  push(topic: string, message: unknown): void;
  /**
   * Fails the app's current subscription to `topic` with a typed error, in the
   * envelope the contract defines: `{ error: { code, message, ... } }`. The
   * supervisor's reconnect logic (`live.ts`) decides what happens next; this
   * only sends the wire event a test needs to trigger it, for example a
   * `validation` error for a stale cursor. Throws if nothing is subscribed to
   * `topic`.
   */
  fail(topic: string, error: unknown): void;
  /**
   * Returns the cursor the app's current subscription to `topic` was opened
   * with, or `undefined` if it started from the head. A caller that seeds an
   * append-only subscription from a page it already has sends this cursor in
   * its first `subscribe` call. Throws if nothing is subscribed to `topic`.
   */
  cursorOf(topic: string): string | undefined;
  /**
   * Closes the app's socket from the server side, as a network failure would.
   * The app then reconnects on its own schedule.
   */
  drop(): void;
}

/**
 * The live connections the current test started, stopped after each test. A
 * supervisor keeps its keepalive running even after the app that started it
 * unmounts, so a connection left behind would still respond during the next
 * test.
 */
const started: Live[] = [];
afterEach(async () => {
  // Unmount the app first. Otherwise a navigation still in flight could pass
  // the entry guard after the stop and start a connection that nothing stops.
  cleanup();
  await Promise.all(started.splice(0).map((live) => live.stop()));
});

/** Returns the element's text with whitespace collapsed, the way a reader sees it. */
export const readPageText = (element: HTMLElement | null = document.body): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * Checks that the elements appear on the page in the given order, and fails
 * the test otherwise. Tests use it, for example, to check that Cancel comes
 * before Confirm.
 */
export const expectInDocumentOrder = (elements: readonly HTMLElement[]): void => {
  elements.forEach((element, index) => {
    const before = elements[index - 1];
    if (before === undefined) return;
    expect(before.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
};

/** Returns the names of the sidebar links marked as the current page. */
export const readCurrentNavItems = (): readonly (string | null)[] =>
  within(screen.getByRole("navigation", { name: "Hercule" }))
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent);

/**
 * Clicks a row inside the open menu - the Radix popover, read as
 * `role="dialog"` - and waits for the menu to be gone.
 *
 * Picking a row gives its name to the menu's trigger button. Until the popover
 * unmounts, the row and the trigger have the same accessible name, and a
 * query for the trigger finds two elements. Waiting for the menu to close
 * makes the trigger the only match.
 */
export const pickRow = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp | string,
): Promise<void> => {
  const menu = await screen.findByRole("dialog");
  await user.click(within(menu).getByRole("button", { name }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
};

/** Renders the whole app at `path`, signed in with `token` if one is given. */
export const renderApp = async ({
  path,
  api,
  token = null,
  detectLocalRunner = () => Promise.resolve(null),
  storage = {},
}: {
  readonly path: string;
  readonly api: FetchLike;
  readonly token?: string | null;
  /** What `localStorage` holds when the app starts. */
  readonly storage?: Readonly<Record<string, string>>;
  /**
   * Returns the runner on this machine. A test has no loopback to probe, so
   * the test passes the result in. The default finds no local runner, which
   * matches a real headless run.
   */
  readonly detectLocalRunner?: (runners: ReadonlyArray<Runner>) => Promise<string | null>;
}) => {
  vi.stubGlobal("localStorage", createMemoryStorage(storage));
  const client = createClient({ baseUrl: BASE_URL, fetch: api, token });
  const sockets: StubSocket[] = [];
  const live = createLive({ client, baseUrl: BASE_URL, webSocket: stubWebSocketInto(sockets) });
  started.push(live);
  const liveStub: LiveStub = {
    topics: () =>
      sockets
        .at(-1)
        ?.subscriptions()
        .map((each) => each.topic) ?? [],
    connected: () => sockets.at(-1)?.readyState === 1,
    push: (topic, message) => {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error("the app has not opened a socket");
      socket.push(topic, message);
    },
    fail: (topic, error) => {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error("the app has not opened a socket");
      const held = socket.subscriptions().find((subscription) => subscription.topic === topic);
      if (held === undefined) throw new Error(`nothing is subscribed to ${topic}`);
      socket.fail(held.requestId, error);
    },
    cursorOf: (topic) => {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error("the app has not opened a socket");
      const held = socket.subscriptions().find((subscription) => subscription.topic === topic);
      if (held === undefined) throw new Error(`nothing is subscribed to ${topic}`);
      const call = socket.calls("subscribe").find((frame) => frame.id === held.requestId);
      return (call?.payload as { cursor?: string } | undefined)?.cursor;
    },
    drop: () => {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error("the app has not opened a socket");
      socket.drop();
    },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    { client, queryClient, live, detectLocalRunner },
    createMemoryHistory({ initialEntries: [path] }),
  );

  followLiveStatus(live, router);

  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await router.load();

  return { router, client, queryClient, live: liveStub, unmount };
};
