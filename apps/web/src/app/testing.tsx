/**
 * What a test needs to run the real app against a stubbed controller.
 *
 * The network is stubbed at `fetch` and at the `WebSocket` constructor, and
 * nowhere else: the client, the live supervisor, the router, the route files
 * and the screens are the ones that ship. A test therefore exercises the same
 * sequencing a browser would, and a change to a route or to the entry guard
 * shows up here rather than in a mock.
 */
import { afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient, createLive, type FetchLike, type Live } from "@hydra/client-core";
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

/** The error envelope, in the shape the API sends it. */
export const envelope = (code: string, message: string): { error: unknown } => ({
  error: { code, message },
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

/** Renders the whole app at `path`, holding `token` from the start if given. */
export const renderApp = async ({
  path,
  api,
  token = null,
}: {
  readonly path: string;
  readonly api: FetchLike;
  readonly token?: string | null;
}) => {
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
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    { client, queryClient, live },
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
