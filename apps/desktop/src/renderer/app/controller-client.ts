/**
 * The clients the app talks to the controller through. Every request they
 * send gives up when the controller does not start its answer in time, or
 * when the answer's body stops arriving for 5 seconds.
 *
 * A controller can accept a connection and never answer, or send the headers
 * and never the body, and neither Chromium nor the client gives up on its own.
 * Without a limit, the entry guard would wait for good at launch and leave the
 * window blank.
 */
import {
  createClient,
  MAX_INPUT_ANSWER_WAIT_MS,
  type FetchLike,
  type HerculeClient,
  type TokenStore,
} from "@hercule/client-core";
import { api } from "@hercule/contract";

/**
 * How long a request waits for the controller to start its answer: the
 * status and the headers. The body is not included; BODY_SILENCE_MS covers it.
 *
 * Main's check of a controller URL (`main/controller-check.ts`) waits 5
 * seconds for its whole answer, which is at most 64 KiB. A controller that
 * passes the check therefore also starts its answers within this limit, so
 * the app does not give up at launch on a controller that Connect accepted.
 *
 * The wait starts when `fetch` is called, so it also counts the time the
 * request queues for one of Chromium's 6 connections to the controller. The
 * fetch API does not say when a request gets its connection.
 */
const HEADER_WAIT_MS = 5000;

/**
 * How long the body of an answer may stop arriving before the request gives
 * up. The limit applies to silence, not to the whole body, so a large answer
 * on a slow link is never cut off while its bytes keep arriving.
 */
const BODY_SILENCE_MS = 5000;

/**
 * How long a request to an operation in RUNNER_WAITING_OPERATIONS waits for
 * the controller to start its answer: the controller's own longest wait, plus
 * 5 seconds for the answer to travel. The controller waits up to 10 seconds
 * for the runner to confirm a message, and up to 2 minutes more while the
 * runner downloads the message's images (spec 17 §Reaching the controller).
 * It sends the headers only after that wait. A limit shorter than that would
 * report a failure for a message that still arrives, and a user who sent it
 * again would send it twice.
 *
 * The limit applies to every message, not only to one with images, because
 * telling them apart would mean parsing the request's body here.
 */
const RUNNER_WAIT_HEADER_WAIT_MS = MAX_INPUT_ANSWER_WAIT_MS + 5000;

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

/**
 * How long a request that uploads up to 10 MiB waits for the controller to
 * start its answer. The controller answers only once the whole upload has
 * arrived, which takes about 85 seconds over a 1 Mbit/s uplink. The fetch API
 * does not report an upload's progress over HTTP/1.1, so the wait cannot be
 * measured as silence, the way a download's body is.
 */
const UPLOAD_HEADER_WAIT_MS = 120_000;

/**
 * The operations whose request carries up to 10 MiB: an image, and a skill's
 * archive. Downloading an image (`attachment.readContent`) needs no limit of
 * its own: its headers come at once, and its body keeps arriving.
 */
const UPLOAD_OPERATIONS = [
  api.groups.attachment.endpoints.create,
  api.groups.skill.endpoints.import,
];

/**
 * The method, path pattern and header wait of each operation that waits
 * longer than HEADER_WAIT_MS, built once at load.
 */
const SLOW_ROUTES = [
  ...RUNNER_WAITING_OPERATIONS.map((operation) => ({
    operation,
    headerWait: RUNNER_WAIT_HEADER_WAIT_MS,
  })),
  ...UPLOAD_OPERATIONS.map((operation) => ({
    operation,
    headerWait: UPLOAD_HEADER_WAIT_MS,
  })),
].map(({ operation, headerWait }) => ({
  method: operation.method,
  pattern: buildPathPattern(operation.path),
  headerWait,
}));

/**
 * Returns how long a request with `method` to `url` waits for the headers of
 * its answer: the wait of its operation when that operation is one of
 * SLOW_ROUTES, HEADER_WAIT_MS for any other.
 */
const decideHeaderWait = (url: string, method: string): number => {
  const { pathname } = new URL(url);
  return (
    SLOW_ROUTES.find((route) => route.method === method && route.pattern.test(pathname))
      ?.headerWait ?? HEADER_WAIT_MS
  );
};

/** Returns `ms` as whole seconds for a message, such as "5 s". */
const formatSeconds = (ms: number): string => `${String(Math.round(ms / 1000))} s`;

/**
 * Sends one request like `fetch`, and aborts it with a `TimeoutError` when:
 *
 * - the status and headers do not arrive within the request's header wait
 *   (`decideHeaderWait`);
 * - the body, once the headers are in, stops arriving for BODY_SILENCE_MS.
 *
 * The abort's message says which limit ran out, and the client puts it in the
 * `ConnectionError` it reports, such as "workspace.query: the controller did
 * not answer within 5 s". The client passes a signal of its own, which still
 * aborts the request too.
 *
 * The timer stops once the request is over: the request fails before an
 * answer arrives, the answer has no body, or the body has been read to the
 * end, has failed or was cancelled. A timer left running would wake an idle
 * app 5 seconds after every request.
 *
 * The silence is measured where the body passes to the client, so a client
 * that stops reading looks like a controller that stops sending. The client
 * does that only for a status the contract does not declare: it fails without
 * reading the body, and the timer then aborts the request after
 * BODY_SILENCE_MS, which closes the connection.
 */
export const fetchWithTimeout: FetchLike = async (url, init) => {
  const timeout = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startTimer = (ms: number, message: string): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timeout.abort(new DOMException(message, "TimeoutError"));
    }, ms);
  };
  const stopTimer = (): void => {
    clearTimeout(timer);
  };

  const headerWait = decideHeaderWait(url, init?.method ?? "GET");
  startTimer(headerWait, `the controller did not answer within ${formatSeconds(headerWait)}`);
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

  const restartSilenceTimer = (): void => {
    startTimer(
      BODY_SILENCE_MS,
      `the controller stopped sending its answer for ${formatSeconds(BODY_SILENCE_MS)}`,
    );
  };
  restartSilenceTimer();
  // The body passes through unchanged, and each piece of it restarts the
  // silence timer. The pipe settles when the body ends, fails or is
  // cancelled. A transformer's `flush` would see only the end: Chromium 152
  // does not call a transformer's `cancel`.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, controller) => {
      restartSilenceTimer();
      controller.enqueue(chunk);
    },
  });
  // When the timer aborts the request, Chromium fails the body with a plain
  // "Failed to fetch", which does not say why. So a failure after the timer
  // fired is passed on with the timer's reason instead.
  response.body.pipeTo(writable, { preventAbort: true }).then(stopTimer, (error: unknown) => {
    stopTimer();
    writable.abort(timeout.signal.aborted ? timeout.signal.reason : error).catch(() => {});
  });
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
