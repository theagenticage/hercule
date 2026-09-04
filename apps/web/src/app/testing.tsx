/**
 * What a test needs to run the real app against a stubbed controller.
 *
 * The network is stubbed at `fetch` and nowhere else: the client, the router,
 * the route files and the screens are the ones that ship. A test therefore
 * exercises the same sequencing a browser would, and a change to a route or to
 * the entry guard shows up here rather than in a mock.
 */
import { render } from "@testing-library/react";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient, type FetchLike } from "@hydra/client-core";
import { createAppRouter } from "./router";

const BASE_URL = "http://controller.test";

/** One request the app made, as the stub saw it. */
export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly token: string | null;
}

/** What a stubbed operation answers with. */
export interface Answer {
  readonly status?: number;
  readonly body: unknown;
}

export type Handler = Answer | ((call: Call) => Answer);

/** The error envelope, in the shape the API sends it. */
export const envelope = (code: string, message: string): { error: unknown } => ({
  error: { code, message },
});

/**
 * A `fetch` that answers the handlers it was given, keyed `METHOD /path`, and
 * records every call. An unstubbed path answers 404, which is what a test that
 * forgot one should see.
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
      body: sent.length === 0 ? undefined : JSON.parse(sent),
      token: authorization === null ? null : authorization.replace(/^Bearer /, ""),
    };
    calls.push(call);

    const handler = handlers[`${call.method} ${call.path}`];
    const answer: Answer =
      handler === undefined
        ? { status: 404, body: envelope("not_found", `no stub for ${call.method} ${call.path}`) }
        : typeof handler === "function"
          ? handler(call)
          : handler;

    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch, calls };
};

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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    { client, queryClient },
    createMemoryHistory({ initialEntries: [path] }),
  );

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await router.load();

  return { router, client, queryClient };
};
