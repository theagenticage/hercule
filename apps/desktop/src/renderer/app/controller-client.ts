/**
 * The clients the app talks to the controller through. Every request they
 * send gives up after 5 seconds, or after 15 for an operation that waits on
 * the runner.
 *
 * A controller can accept a connection and never answer, or send the headers
 * and never the body, and neither Chromium nor the client gives up on its own.
 * Without a limit, the entry guard would wait for good at launch and leave the
 * window blank.
 */
import {
  createClient,
  type FetchLike,
  type HerculeClient,
  type TokenStore,
} from "@hercule/client-core";
import { api } from "@hercule/contract";

/**
 * How long a request waits for the controller's whole answer. Main's check of
 * a controller URL (`main/controller-check.ts`) waits the same 5 seconds.
 * The two stay equal, so a controller that Connect accepts is never one the
 * app then gives up on at launch.
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * How long a request to an operation in RUNNER_WAITING_OPERATIONS waits for
 * the controller's whole answer. The controller itself waits up to 10 seconds
 * for the runner to confirm the message (spec 17 §Reaching the controller).
 * A limit shorter than that would report a failure for a message that still
 * arrives, and a user who sent it again would send it twice.
 */
const RUNNER_WAIT_TIMEOUT_MS = 15_000;

/**
 * The operations whose answer waits on the runner: sending a message to a
 * session, and steering a queued input into its running turn. They are read
 * from the API declaration the client is built from, so their method and path
 * cannot drift from the requests the client sends.
 */
const RUNNER_WAITING_OPERATIONS = [
  api.groups.session.endpoints.input,
  api.groups.input.endpoints.steer,
];

/**
 * Returns a pattern that matches the path of any call of an operation whose
 * path is `path`, such as `/api/v1/sessions/:id/input`: each `:param` matches
 * one path segment. The API's paths hold only letters, `-`, `/` and
 * `:param`s, so no character needs escaping.
 */
const buildPathPattern = (path: string): RegExp =>
  new RegExp(`^${path.replace(/:[^/]+/g, "[^/]+")}$`);

/** The method and path pattern of each operation that waits on the runner, built once at load. */
const RUNNER_WAITING_ROUTES = RUNNER_WAITING_OPERATIONS.map((operation) => ({
  method: operation.method,
  pattern: buildPathPattern(operation.path),
}));

/**
 * Returns how long a request with `method` to `url` may take: longer for an
 * operation that waits on the runner, REQUEST_TIMEOUT_MS for any other.
 */
const decideRequestTimeout = (url: string, method: string): number => {
  const { pathname } = new URL(url);
  return RUNNER_WAITING_ROUTES.some(
    (route) => route.method === method && route.pattern.test(pathname),
  )
    ? RUNNER_WAIT_TIMEOUT_MS
    : REQUEST_TIMEOUT_MS;
};

/**
 * Sends one request like `fetch`, and aborts it when the whole answer, body
 * included, takes longer than its limit (`decideRequestTimeout`). The client
 * reports the abort as a `ConnectionError`, as it does when nothing answers.
 * The client passes a signal of its own, which still aborts the request too.
 *
 * The timer stops once the request is over: the request fails before an
 * answer arrives, the answer has no body, or the body has been read to the
 * end, has failed or was cancelled. A timer left running would wake an idle
 * app 5 seconds after every request.
 *
 * One answer keeps the timer running anyway. For a status the contract does
 * not declare, the client fails without reading or cancelling the body, and
 * nothing tells this function that the body is no longer wanted. The timer
 * then fires after the full limit and aborts the request, which closes the
 * connection. That costs one wakeup, and the connection stays open for up to
 * the limit after such an answer.
 */
export const fetchWithTimeout: FetchLike = async (url, init) => {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => {
      timeout.abort(new DOMException("The controller did not answer in time.", "TimeoutError"));
    },
    decideRequestTimeout(url, init?.method ?? "GET"),
  );
  const stopTimer = (): void => {
    clearTimeout(timer);
  };

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal,
    });
  } catch (error) {
    stopTimer();
    throw error;
  }
  if (response.body === null) {
    stopTimer();
    return response;
  }

  // The body passes through unchanged. The pipe settles when the body ends,
  // fails or is cancelled. A transformer's `flush` would see only the end:
  // Chromium 152 does not call a transformer's `cancel`.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  response.body.pipeTo(writable).then(stopTimer, stopTimer);
  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/** Creates the client for the controller at `url`, keeping its token in `tokenStore`. */
export const createControllerClient = (url: string, tokenStore: TokenStore): HerculeClient =>
  createClient({ baseUrl: url, tokenStore, fetch: fetchWithTimeout });

/**
 * Asks the controller at `url` to revoke `token`, and ignores the answer.
 * Returns at once and never fails.
 *
 * The call goes through a client of its own, which holds only `token` and
 * has no token store. A successful logout clears its client's token, and on
 * this client that touches nothing else: not the store, and not a token the
 * user got by signing in again while the revoke was still waiting.
 */
export const revokeToken = (url: string, token: string): void => {
  createClient({ baseUrl: url, token, fetch: fetchWithTimeout })
    .auth.logout()
    // Spec 17: Sign Out ignores the answer. The app has already forgotten the
    // token, and a controller that is down cannot revoke it anyway.
    .catch(() => {});
};
