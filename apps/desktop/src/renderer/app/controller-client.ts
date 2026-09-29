/**
 * The clients the app talks to the controller through. Every request they
 * send gives up after 5 seconds.
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

/**
 * How long a request waits for the controller's whole answer. Main's check of
 * a controller URL (`main/controller-check.ts`) waits the same 5 seconds.
 * The two stay equal, so a controller that Connect accepts is never one the
 * app then gives up on at launch.
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Sends one request like `fetch`, and aborts it when the whole answer, body
 * included, takes longer than REQUEST_TIMEOUT_MS. The client reports the
 * abort as a `ConnectionError`, as it does when nothing answers. The client
 * passes a signal of its own, which still aborts the request too.
 *
 * The timer stops once the request is over: the request fails before an
 * answer arrives, the answer has no body, or the body has been read to the
 * end, has failed or was cancelled. A timer left running would wake an idle
 * app 5 seconds after every request.
 *
 * One answer keeps the timer running anyway. For a status the contract does
 * not declare, the client fails without reading or cancelling the body, and
 * nothing tells this function that the body is no longer wanted. The timer
 * then fires after the full 5 seconds and aborts the request, which closes
 * the connection. That costs one wakeup, and the connection stays open for up
 * to 5 seconds after such an answer.
 */
export const fetchWithTimeout: FetchLike = async (url, init) => {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(new DOMException("The controller did not answer in time.", "TimeoutError"));
  }, REQUEST_TIMEOUT_MS);
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
