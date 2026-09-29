/**
 * The check main runs on a controller URL before it saves it: does a
 * Hercule controller answer there, is it set up, and does it accept the
 * desktop app's page?
 *
 * Main makes plain requests, not calls through the contract's client,
 * because it must read the CORS headers of the answers, which the client does
 * not expose. The path and the response's schema come from the contract all
 * the same. It sends them with the function it is given, which in the app
 * uses the page's own network stack; see `./fetch-without-redirects`.
 *
 * Main imports this module only when the user first connects, so it is not
 * on the launch path.
 */
import {
  ALL_OPERATIONS,
  DESKTOP_APP_ORIGIN,
  OPERATIONS,
  SetupState,
  type Method,
} from "@hercule/contract";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { FetchWithoutRedirects } from "./fetch-without-redirects";

/**
 * What the check found at a controller's origin:
 *
 * - `Ready`: a set-up controller answered, and it accepts the desktop app;
 * - `Unreachable`: nothing answered within 5 seconds;
 * - `Redirected`: the origin redirects the controller's API to the same path
 *   at another origin, `targetOrigin`, as a proxy that sends http to https does;
 * - `NotController`: something answered, but not a Hercule controller;
 * - `OriginNotAllowed`: a controller answered, but its answer does not let the
 *   desktop app's page read it: the controller is older than the desktop app;
 * - `PreflightRefused`: the controller lets the page read its answer, but the
 *   CORS preflight refuses the page's calls with each method in `methods`, as
 *   a proxy in front of the controller can;
 * - `SetupIncomplete`: a controller answered, and it is not set up yet.
 */
export type ControllerCheckOutcome =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Unreachable" }
  | { readonly _tag: "Redirected"; readonly targetOrigin: string }
  | { readonly _tag: "NotController" }
  | { readonly _tag: "OriginNotAllowed" }
  | { readonly _tag: "PreflightRefused"; readonly methods: ReadonlyArray<Method> }
  | { readonly _tag: "SetupIncomplete" };

/** How long the check waits for the controller's answers, all the requests together. */
const CHECK_TIMEOUT = "5 seconds";

/**
 * The methods the page's calls to the controller use: each method in the
 * operation table, once, sorted. Chromium sends a preflight before each call
 * that carries the login token, and a preflight asks about one method, so the
 * check sends one preflight per method.
 */
const API_METHODS: ReadonlyArray<Method> = [
  ...new Set(ALL_OPERATIONS.map((operation) => operation.method)),
].sort();

/** The methods CORS always allows, so a preflight's answer need not list them. */
const SAFELISTED_METHODS: ReadonlyArray<string> = ["GET", "HEAD", "POST"];

/**
 * The longest body the check reads. The setup state is a few bytes; the
 * limit stops an endpoint that streams for the whole timeout from filling
 * main's memory.
 */
const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Reads the body of `response` as text, or returns null as soon as it is
 * longer than BODY_LIMIT_BYTES, and then stops reading it.
 */
const readLimitedBody = async (response: Pick<Response, "body">): Promise<string | null> => {
  if (response.body === null) return "";
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  // A fetch body is a stream of bytes; Node's types leave the chunk untyped.
  for await (const chunk of response.body as ReadableStream<Uint8Array>) {
    length += chunk.byteLength;
    // Leaving the loop cancels the stream.
    if (length > BODY_LIMIT_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/** The parts of the controller's answer to the setup read that the check uses. */
interface SetupReadAnswer {
  readonly status: number;
  /** The `location` header, or null when there is none. */
  readonly location: string | null;
  /** The `access-control-allow-origin` header, or null when there is none. */
  readonly allowedOrigin: string | null;
  /** The body, or null when it is longer than BODY_LIMIT_BYTES. */
  readonly body: string | null;
}

/**
 * Asks for the setup state at `url` with `fetch`, as the desktop app's page
 * would: with the page's origin in the `Origin` header. Fails when the
 * request or the reading of the body fails, and stops the request when the
 * effect is interrupted.
 */
const readSetupAnswer = (url: URL, fetch: FetchWithoutRedirects) =>
  Effect.tryPromise(async (signal): Promise<SetupReadAnswer> => {
    const response = await fetch(url, {
      method: "GET",
      headers: { origin: DESKTOP_APP_ORIGIN },
      signal,
    });
    return {
      status: response.status,
      location: response.headers.get("location"),
      allowedOrigin: response.headers.get("access-control-allow-origin"),
      body: await readLimitedBody(response),
    };
  });

/**
 * Returns the origin a redirect from `url` to `location`, the answer's
 * `location` header, moves `url` to. Returns null when the redirect goes to
 * another path, adds anything to the path, stays at the same origin, or
 * `location` does not parse. A relative `location` is resolved against `url`.
 *
 * Only an origin is returned because the user can connect to an origin; a
 * redirect elsewhere, such as to a login page, is no address to connect to.
 * A redirect to the same origin would send the user back where they started.
 */
const findMovedOrigin = (url: URL, location: string): string | null => {
  const target = URL.parse(location, url.href);
  if (target === null || target.origin === url.origin) return null;
  // The full URL is the origin plus the path exactly when the redirect adds
  // no user name, password, query or fragment.
  return target.href === `${target.origin}${url.pathname}` ? target.origin : null;
};

/**
 * Checks whether `allowedOrigin`, an answer's `access-control-allow-origin`
 * header, lets the desktop app's page read the answer, by the rule Chromium
 * applies to the page's calls: the header must be exactly the page's origin
 * or `*`. A `*` counts because the page's calls send no credentials, such as
 * cookies. A header sent twice arrives as one value joined with ", ", such as
 * `app://hercule, *`, and is refused, as Chromium refuses it.
 */
const allowsDesktopAppOrigin = (allowedOrigin: string | null): boolean =>
  allowedOrigin === DESKTOP_APP_ORIGIN || allowedOrigin === "*";

/** Splits a comma-separated header, such as `access-control-allow-headers`, into its trimmed items. */
const parseHeaderList = (header: string | null): ReadonlyArray<string> =>
  header?.split(",").map((item) => item.trim()) ?? [];

/**
 * Sends to `url`, with `fetch`, the CORS preflight that the desktop app's
 * page sends before it calls the controller with `method` and its login
 * token. Returns whether the answer lets that call through, by the rules
 * Chromium applies to it. The call has an `authorization` header and a JSON
 * `content-type`, and it sends no credentials, such as cookies. The answer
 * lets it through when:
 *
 * - its status is 2xx, and not a redirect;
 * - it allows the page's origin, by name or with `*`; see allowsDesktopAppOrigin;
 * - it allows `method`, by name or with `*`, unless CORS always allows it, as
 *   it does GET, HEAD and POST. Chromium compares the method with its case,
 *   so `patch` does not allow PATCH;
 * - it allows the `authorization` header by name, because `*` never covers
 *   that header;
 * - it allows the `content-type` header, by name or with `*`.
 *
 * A `*` counts only because the call sends no credentials.
 *
 * Fails when the request fails.
 */
const sendPreflight = (url: URL, method: Method, fetch: FetchWithoutRedirects) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: DESKTOP_APP_ORIGIN,
        "access-control-request-method": method,
        "access-control-request-headers": "authorization, content-type",
      },
      signal,
    });
    await response.body?.cancel();
    const methods = parseHeaderList(response.headers.get("access-control-allow-methods"));
    const headers = parseHeaderList(response.headers.get("access-control-allow-headers")).map(
      (header) => header.toLowerCase(),
    );
    return (
      response.status >= 200 &&
      response.status < 300 &&
      allowsDesktopAppOrigin(response.headers.get("access-control-allow-origin")) &&
      (SAFELISTED_METHODS.includes(method) || methods.includes(method) || methods.includes("*")) &&
      headers.includes("authorization") &&
      (headers.includes("content-type") || headers.includes("*"))
    );
  });

/** Decodes a response body as the controller's setup state, or returns none. */
const decodeSetupState = Schema.decodeUnknownOption(Schema.fromJsonString(SetupState));

/**
 * Checks the controller at `origin`, such as `http://127.0.0.1:4937`, and
 * returns what it found; see ControllerCheckOutcome. The outcomes are tried
 * in the order that type lists them, after `Ready`, so a controller that is
 * both older than the desktop app and not set up is `OriginNotAllowed`.
 * Never fails.
 *
 * The check reads the setup state, and then sends the preflights to the same
 * path, one per method in API_METHODS, all at once. It sends every request
 * with `fetch`.
 */
export const checkController = (
  origin: string,
  fetch: FetchWithoutRedirects,
): Effect.Effect<ControllerCheckOutcome> => {
  const url = new URL(OPERATIONS["setup.read"].path, origin);
  return Effect.gen(function* () {
    const answer = yield* readSetupAnswer(url, fetch);
    const movedOrigin =
      answer.status >= 300 && answer.status < 400 && answer.location !== null
        ? findMovedOrigin(url, answer.location)
        : null;
    if (movedOrigin !== null) return { _tag: "Redirected", targetOrigin: movedOrigin } as const;
    const state =
      answer.status === 200 && answer.body !== null ? decodeSetupState(answer.body) : Option.none();
    if (Option.isNone(state)) return { _tag: "NotController" } as const;
    if (!allowsDesktopAppOrigin(answer.allowedOrigin)) return { _tag: "OriginNotAllowed" } as const;
    // The setup read was answered, so a preflight that fails to get an answer
    // is refused by whatever sits in front of the controller.
    const passed = yield* Effect.forEach(
      API_METHODS,
      (method) => sendPreflight(url, method, fetch).pipe(Effect.orElseSucceed(() => false)),
      { concurrency: "unbounded" },
    );
    const refusedMethods = API_METHODS.filter((_method, index) => !passed[index]);
    if (refusedMethods.length > 0) {
      return { _tag: "PreflightRefused", methods: refusedMethods } as const;
    }
    return { _tag: state.value.complete ? "Ready" : "SetupIncomplete" } as const;
  }).pipe(
    Effect.timeout(CHECK_TIMEOUT),
    Effect.catch(() => Effect.succeed({ _tag: "Unreachable" } as const)),
  );
};
