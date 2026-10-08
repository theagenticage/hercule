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
import {
  createClient,
  createLive,
  createUploadQueue,
  UPLOAD_CONCURRENCY,
  type FetchLike,
  type Live,
} from "@hercule/client-core";
import type { Runner } from "@hercule/contract";
import {
  createApiStub,
  StubSocket,
  stubWebSocketInto,
  type Call,
  type Handler,
} from "@hercule/client-core/testing";
import { createMemoryStorage } from "@hercule/ui/testing";
import { createAppRouter } from "./router";
import { followLiveStatus } from "./live-status";

const BASE_URL = "http://controller.test";

// The fake API is shared with the desktop app's tests. A test imports it from
// here with the rest of the harness.
export { buildErrorBody, type Answer, type Call, type Handler } from "@hercule/client-core/testing";

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
 * `METHOD /path`, and records every call (see `createApiStub`). An unstubbed
 * path returns 404, so a test that forgot a route notices. The housekeeping
 * routes above are the exception, because every screen's test would
 * otherwise have to stub them.
 */
export const stubApi = (
  handlers: Readonly<Record<string, Handler>>,
): { readonly fetch: FetchLike; readonly calls: readonly Call[] } =>
  createApiStub({ ...HOUSEKEEPING, ...handlers });

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
  readCursor(topic: string): string | undefined;
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

/** The three values of a scroll container's geometry that `useStickToBottom` reads. */
export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** The fake scroll geometry of the shell's `main` that `fakeMainScrollGeometry` installs. */
export interface FakeScrollGeometry {
  /** Sets all three values; the screen's own writes to `scrollTop` also land here. */
  readonly set: (values: ScrollGeometry) => void;
  /** Returns the current `scrollTop` of `main`. */
  readonly readScrollTop: () => number;
  /** Fires a `scroll` event on `main`, as a user scrolling would. */
  readonly scroll: () => void;
  /** Puts jsdom's own geometry back. */
  readonly restore: () => void;
}

const SCROLL_GEOMETRY_KEYS = ["scrollTop", "scrollHeight", "clientHeight"] as const;

/**
 * Fakes the scroll geometry of the shell's `main`, the one element inside the
 * shell that scrolls. jsdom computes no layout, so a test sets by hand the
 * values that `useStickToBottom` reads. Every other element keeps jsdom's
 * values.
 *
 * The fake is installed on `Element.prototype`, not on the `main` element, so
 * it can be installed before the app renders: a screen scrolls from its mount
 * effect, before the test could reach the element. Call `restore` after the
 * test.
 */
export const fakeMainScrollGeometry = (): FakeScrollGeometry => {
  const geometry: { -readonly [Key in keyof ScrollGeometry]: number } = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  const isMain = (element: Element): boolean => element.tagName === "MAIN";
  const originals = SCROLL_GEOMETRY_KEYS.map(
    (key) => [key, Object.getOwnPropertyDescriptor(Element.prototype, key)!] as const,
  );
  for (const [key, original] of originals) {
    Object.defineProperty(Element.prototype, key, {
      configurable: true,
      get(this: Element): number {
        // jsdom's own getter is typed as returning `any`; all three values are numbers.
        return isMain(this) ? geometry[key] : (original.get?.call(this) as number);
      },
      set(this: Element, value: number) {
        if (isMain(this)) geometry[key] = value;
        else original.set?.call(this, value);
      },
    });
  }
  // The router scrolls `main` back to the top after every navigation. A test
  // sees that reset too, so a screen that opens at the bottom is checked
  // against it.
  const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo")!;
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value(this: Element, options: ScrollToOptions) {
      if (isMain(this)) geometry.scrollTop = options.top ?? geometry.scrollTop;
    },
  });
  return {
    set: (values) => {
      Object.assign(geometry, values);
    },
    readScrollTop: () => geometry.scrollTop,
    scroll: () => {
      const main = document.querySelector("main");
      if (main === null) throw new Error("The shell's main element is not on the page.");
      main.dispatchEvent(new Event("scroll"));
    },
    restore: () => {
      for (const [key, original] of originals)
        Object.defineProperty(Element.prototype, key, original);
      Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
    },
  };
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
  const readSocket = (): StubSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("the app has not opened a socket");
    return socket;
  };
  const liveStub: LiveStub = {
    topics: () =>
      sockets
        .at(-1)
        ?.subscriptions()
        .map((each) => each.topic) ?? [],
    connected: () => sockets.at(-1)?.readyState === 1,
    push: (topic, message) => {
      readSocket().push(topic, message);
    },
    fail: (topic, error) => {
      const socket = readSocket();
      socket.fail(socket.findSubscription(topic).requestId, error);
    },
    readCursor: (topic) => readSocket().findSubscription(topic).cursor,
    drop: () => {
      readSocket().drop();
    },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    {
      client,
      queryClient,
      live,
      uploads: createUploadQueue({
        upload: client.uploadAttachment,
        deleteAttachment: client.deleteAttachment,
        concurrency: UPLOAD_CONCURRENCY,
      }),
      detectLocalRunner,
    },
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
