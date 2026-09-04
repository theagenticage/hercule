/**
 * The web bundle, served from the same origin and the same port as the API.
 *
 * The bundle is `vite build`'s output, embedded in the binary file by file
 * (`./bundle.ts`, generated). Nothing here reads a directory: a compiled binary
 * has no `dist/` on disk, so every file the bundle holds is named up front and
 * reached through `Bun.file`, which is the one reader that understands the
 * embedded filesystem.
 *
 * Serving is transport, not an operation: it touches no service, stamps no
 * actor, and writes nothing. It is expressed as a wrapper around the API
 * application rather than a route of its own, so **the router still decides
 * what is an API request**. Only a request the router matched nothing for can
 * reach the bundle, which is what keeps `//api/v1/secrets` an API request
 * rather than a deep link.
 *
 * Two rules shape the rest:
 *
 * - A path under the API prefix is never the bundle's, so an unknown operation
 *   keeps the JSON error envelope instead of being answered with HTML.
 * - A path under `/assets/` is a fingerprinted file or nothing. Falling back to
 *   `index.html` there would answer a stale chunk request with a page.
 *
 * Every other `GET` is a deep link and gets `index.html`; the router in the
 * browser takes it from there.
 */
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PREFIX } from "@hydra/contract";

/**
 * The built web app: where its `index.html` is, and where every file it can
 * ask for is, by the path a browser asks for it under.
 *
 * The values are filesystem paths - `$bunfs/...` in a compiled binary, an
 * ordinary path when the controller runs from source.
 */
export interface WebBundle {
  readonly index: string;
  readonly files: ReadonlyMap<string, string>;
}

/**
 * What the browser is allowed to load and where it may talk to.
 *
 * The bearer token lives in `localStorage` and agent-authored text is rendered
 * all over the app, so any script that runs can read the credential. No inline
 * script is permitted and nothing may be fetched cross-origin.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Fingerprinted files: the name changes when the content does, so they never expire. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Everything else, `index.html` above all: revalidate on every load. */
const REVALIDATE = "no-cache";

/** Where Vite puts the fingerprinted files. */
const ASSETS = "/assets/";

/** Anything under the API prefix, however it is spelled; the router matches case-insensitively. */
const API_PATH = new RegExp(`^/+${API_PREFIX.slice(1)}(/|$)`, "i");

/** What the bundle can contain. Anything else is served as bytes. */
const CONTENT_TYPE: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  woff2: "font/woff2",
};

const contentTypeOf = (path: string): string =>
  CONTENT_TYPE[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/**
 * The path a request asks for, without the query or the fragment.
 *
 * Sliced rather than parsed: `new URL("//api/v1/x", base)` reads the leading
 * `//` as an authority and hands back `/x`, which would turn an API path into a
 * deep link.
 */
const pathOf = (url: string): string => {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
};

/** Whether the router matched nothing, which is the only way the bundle is reached. */
const routeNotFound = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => {
    if (reason._tag === "Interrupt") return false;
    const error = reason._tag === "Fail" ? reason.error : reason.defect;
    return HttpServerError.isHttpServerError(error) && error.reason._tag === "RouteNotFound";
  });

const respond = (file: string, cacheControl: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.raw(Bun.file(file), {
    contentType: contentTypeOf(file),
    headers: {
      "cache-control": cacheControl,
      "content-security-policy": CONTENT_SECURITY_POLICY,
      // The type above is the one the browser must use. Anything the table
      // does not name is served as bytes, and bytes must not be sniffed into
      // a script.
      "x-content-type-options": "nosniff",
    },
  });

/** What the bundle answers this request with, or nothing when it owns none of it. */
const answer = (
  bundle: WebBundle,
  request: HttpServerRequest.HttpServerRequest,
): HttpServerResponse.HttpServerResponse | undefined => {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const path = pathOf(request.url);
  if (API_PATH.test(path)) return undefined;
  const file = bundle.files.get(path);
  if (file !== undefined) return respond(file, path.startsWith(ASSETS) ? IMMUTABLE : REVALIDATE);
  return path.startsWith(ASSETS) ? undefined : respond(bundle.index, REVALIDATE);
};

/**
 * Answers what the API routes did not with the web bundle, leaving every
 * request the bundle does not own to fail on as it did before.
 *
 * With no bundle - the controller run from a checkout that has not been built -
 * nothing changes: every non-API path is a 404 in the error envelope.
 */
export const withWebBundle =
  (bundle: WebBundle | undefined) =>
  <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > =>
    bundle === undefined
      ? app
      : Effect.catchCause(app, (cause) =>
          routeNotFound(cause)
            ? Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
                const response = answer(bundle, request);
                return response === undefined ? Effect.failCause(cause) : Effect.succeed(response);
              })
            : Effect.failCause(cause),
        );
