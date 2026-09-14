/**
 * What a test needs to run the real app against a stubbed controller.
 *
 * The network is stubbed at `fetch` and at the `WebSocket` constructor, and
 * nowhere else: the client, the live supervisor, the router, the route files
 * and the screens are the ones that ship. A test therefore exercises the same
 * sequencing a browser would, and a change to a route or to the entry guard
 * shows up here rather than in a mock.
 */
import { afterEach, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient, createLive, type FetchLike, type Live } from "@hydra/client-core";
import type { Runner } from "@hydra/contract";
import { StubSocket, openInto } from "@hydra/client-core/testing";
import { createAppRouter } from "./router";
import { followLiveStatus } from "./live-status";

const BASE_URL = "http://controller.test";

/** One request the app made, as the stub saw it. */
export interface Call {
  readonly method: string;
  readonly path: string;
  /** The query string as it went out, leading `?` and all; empty when there was none. */
  readonly search: string;
  readonly body: unknown;
  readonly token: string | null;
}

/** What a stubbed operation answers with. */
export interface Answer {
  readonly status?: number;
  readonly body: unknown;
}

/**
 * What one operation answers with. A handler may answer later rather than at
 * once, which is how a test holds one write open while it makes another.
 */
export type Handler = Answer | ((call: Call) => Answer | Promise<Answer>);

/** The error envelope as the API sends it; only a `validation` refusal carries issues. */
export const envelope = (code: string, message: string): { error: unknown } => ({
  error: {
    code,
    message,
    ...(code === "validation" ? { details: { issues: [{ path: [], message }] } } : {}),
  },
});

/**
 * What the app asks for on its own, whatever the screen under test is. A test
 * that cares - one refusing the ticket, say - names the route itself and its
 * answer wins.
 */
const HOUSEKEEPING: Readonly<Record<string, Handler>> = {
  "POST /api/v1/auth/ws-ticket": { body: { ticket: "ws-ticket" } },
};

/**
 * A `fetch` that answers the handlers it was given, keyed `METHOD /path`, and
 * records every call. An unstubbed path answers 404, which is what a test that
 * forgot one should see - except for the housekeeping above, which every
 * screen's test would otherwise have to stub.
 */
export const stubApi = (
  handlers: Readonly<Record<string, Handler>>,
): { readonly fetch: FetchLike; readonly calls: readonly Call[] } => {
  const calls: Call[] = [];

  const fetch: FetchLike = async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    // The body may arrive as a stream rather than a string, so it is read the
    // way the controller reads it.
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
        ? { status: 404, body: envelope("not_found", `no stub for ${call.method} ${call.path}`) }
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
 * The live connection as a test sees it: what the app is watching, and a way
 * to press one push onto it. Everything the wire framing needs is the stub
 * socket's business.
 */
export interface LiveStub {
  /** The topics the app is subscribed to right now, oldest first. */
  topics(): readonly string[];
  /** Whether the app is holding a socket open at all. */
  connected(): boolean;
  /**
   * Delivers one message on the app's subscription to `topic`, in the shape
   * the contract sends it: `{ _tag: "invalidate", ids, kind }` for a mutable
   * topic. Pushing to a topic nothing is watching throws.
   */
  push(topic: string, message: unknown): void;
  /**
   * Refuses the app's current subscription to `topic` with a typed failure, in
   * the envelope the contract sends it: `{ error: { code, message, ... } }`.
   * What the supervisor does next is its own reconnect logic (`live.ts`); this
   * is only the wire event a test presses to reach it - a stale cursor
   * refused `validation`, say. Failing a topic nothing is watching throws.
   */
  fail(topic: string, error: unknown): void;
  /**
   * The cursor the app's current subscription to `topic` was opened with, or
   * `undefined` for one that started from the head - what a caller seeding an
   * append-only subscription from a page it already holds sends as its first
   * `subscribe` call. Asking about a topic nothing is watching throws.
   */
  cursorOf(topic: string): string | undefined;
}

/**
 * The connections a test started, ended when it finishes. A supervisor keeps a
 * keepalive running whether or not the app that started it is still mounted,
 * so leaving one behind would have one test's socket answering during the next.
 */
const started: Live[] = [];
afterEach(async () => {
  // The app comes down first: a navigation still in flight would otherwise pass
  // the entry guard after the stop and start a connection nothing ends.
  cleanup();
  await Promise.all(started.splice(0).map((live) => live.stop()));
});

/** The page's text with its whitespace collapsed, the way a reader sees it. */
export const reading = (element: HTMLElement | null = document.body): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * Clicks a row inside the open menu - the Radix popover, read as
 * `role="dialog"` - and waits for the menu to be gone.
 *
 * A pick hands its name to the trigger it changes: right after the click the
 * row and the trigger both answer to the same name until the popover
 * unmounts, and a query for the trigger finds two elements. Waiting for the
 * menu to close is what makes the trigger the only match.
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

/**
 * A `localStorage` that lives in memory for one render.
 *
 * Whether this jsdom has a `localStorage` of its own depends on the Node it
 * runs under - Node 22 exposes one and persists it across the tests in a file,
 * later Node versions leave `window.localStorage` undefined, which is why
 * `client-core`'s own token store reaches it through a try. A stub makes both
 * read the same: every render starts from the seed it was given and nothing
 * one test writes reaches the next.
 */
export const memoryStorage = (seed: Readonly<Record<string, string>> = {}): Storage => {
  const held = new Map(Object.entries(seed));
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, String(value));
    },
    removeItem: (key) => {
      held.delete(key);
    },
    clear: () => {
      held.clear();
    },
    key: (index) => [...held.keys()][index] ?? null,
    get length() {
      return held.size;
    },
  };
};

/** Renders the whole app at `path`, holding `token` from the start if given. */
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
   * Which runner is on this machine. There is no loopback to probe in a test,
   * so the answer is handed over rather than fetched; without one, nothing on
   * this browser answers, which is what a headless run really is.
   */
  readonly detectLocalRunner?: (runners: ReadonlyArray<Runner>) => Promise<string | null>;
}) => {
  vi.stubGlobal("localStorage", memoryStorage(storage));
  const client = createClient({ baseUrl: BASE_URL, fetch: api, token });
  const sockets: StubSocket[] = [];
  const live = createLive({ client, baseUrl: BASE_URL, webSocket: openInto(sockets) });
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
