/**
 * A fake controller API for tests, played at `fetch`.
 *
 * The web app's tests and the desktop app's tests both run the real client
 * against it, so the two apps' tests read requests and build responses the
 * same way. It is imported as `@hercule/client-core/testing`, which no app
 * code imports.
 */
import type { FetchLike } from "./client";

/** One request the app sent the controller, as the stub received it. */
export interface Call {
  readonly method: string;
  readonly path: string;
  /** The query string as sent, with its leading `?`, or empty when there was none. */
  readonly search: string;
  readonly body: unknown;
  /** The `authorization` header, such as `Bearer <token>`, or `null` when the request had none. */
  readonly authorization: string | null;
}

/** The response a stubbed operation returns. */
export interface Answer {
  readonly status?: number;
  readonly body: unknown;
}

/**
 * The response for one operation, or a function that builds it.
 *
 * - A function may return a promise that resolves later, which lets a test
 *   keep one request pending while the app makes another.
 * - A function that throws or rejects makes `fetch` reject, as it does when
 *   the controller cannot be reached.
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

/** Returns a promise that rejects with the signal's reason when `signal` aborts, as `fetch` does. */
const rejectOnAbort = (signal: AbortSignal | null | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        // Every abort in the apps passes an Error as its reason, such as the
        // TimeoutError of a request's time limit.
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

/**
 * Returns a `fetch` that responds from `handlers`, keyed `METHOD /path`, and
 * the list of calls it receives, oldest first.
 *
 * - An unstubbed path returns 404, so a test that forgot a route notices.
 * - A handler's answer that is still pending when the request's signal aborts
 *   is dropped, and `fetch` rejects with the signal's reason, as a real
 *   request does.
 */
export const createApiStub = (
  handlers: Readonly<Record<string, Handler>>,
): { readonly fetch: FetchLike; readonly calls: readonly Call[] } => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const request = new Request(url, init);
    // The body may arrive as a stream rather than a string, so it is read the
    // way the controller reads it.
    const sent = await request.text();
    const address = new URL(url);
    const call: Call = {
      method: request.method,
      path: address.pathname,
      search: address.search,
      body: sent.length === 0 ? undefined : JSON.parse(sent),
      authorization: request.headers.get("authorization"),
    };
    calls.push(call);
    const handler = handlers[`${call.method} ${call.path}`];
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
  };
  return { fetch, calls };
};
