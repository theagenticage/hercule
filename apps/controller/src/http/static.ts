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
import { API_PREFIX } from "@hercule/contract";
import { IDENTITY_PORT, IDENTITY_PORT_COUNT } from "@hercule/protocol";

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
 * The ports the app may ask on the reader's own machine: the ones a runner's
 * identity listener will settle for, and no others.
 *
 * Named one by one rather than as `127.0.0.1:*`, because a wildcard port would
 * let anything that runs in this page speak to every service on the reader's
 * machine, and the whole reason this policy exists is that such a script has to
 * be assumed. Ten ports is not one request: the directive can name a host and a
 * port and nothing finer, so what it grants is any method and any path on those
 * ten, where the app itself makes one `GET /identity`.
 */
const IDENTITY_PORTS = Array.from(
  { length: IDENTITY_PORT_COUNT },
  (_, offset) => `http://127.0.0.1:${String(IDENTITY_PORT + offset)}`,
).join(" ");

/**
 * What the browser is allowed to load and where it may talk to.
 *
 * The bearer token lives in `localStorage` and agent-authored text is rendered
 * all over the app, so a script that runs can read the credential. The
 * load-bearing directive against that is `script-src 'self'` with no inline
 * script, because it is what keeps such a script from running: a policy has no
 * say over where a page navigates, so a script that does run can still carry
 * the token away in an address bar. What the directives below remove is every
 * quiet channel - a fetch, an image, a font, a frame - and the only addresses
 * off this origin left open are the loopback ports above, where the fleet asks
 * each runner which machine the browser is sitting on.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  `connect-src 'self' ${IDENTITY_PORTS}`,
  "img-src 'self' data:",
  "font-src 'self'",
  // CodeMirror, the workflow YAML editor, adds its base styles in a `<style>`
  // element when it starts. `style-src 'self'` blocks that element, and the
  // editor renders unstyled. Allowing inline styles is safe here: an inline
  // style cannot load anything from another origin, because `img-src` and
  // `font-src` allow only this origin. `script-src` still blocks inline scripts.
  "style-src 'self' 'unsafe-inline'",
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

const detectContentType = (path: string): string =>
  CONTENT_TYPE[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/**
 * The path a request asks for, without the query or the fragment.
 *
 * Sliced rather than parsed: `new URL("//api/v1/x", base)` reads the leading
 * `//` as an authority and hands back `/x`, which would turn an API path into a
 * deep link.
 */
const stripQueryAndFragment = (url: string): string => {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
};

/** Whether the router matched nothing, which is the only way the bundle is reached. */
const isRouteNotFound = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => {
    if (reason._tag === "Interrupt") return false;
    const error = reason._tag === "Fail" ? reason.error : reason.defect;
    return HttpServerError.isHttpServerError(error) && error.reason._tag === "RouteNotFound";
  });

const buildFileResponse = (
  file: string,
  cacheControl: string,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.raw(Bun.file(file), {
    contentType: detectContentType(file),
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
const findBundleResponse = (
  bundle: WebBundle,
  request: HttpServerRequest.HttpServerRequest,
): HttpServerResponse.HttpServerResponse | undefined => {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const path = stripQueryAndFragment(request.url);
  if (API_PATH.test(path)) return undefined;
  const file = bundle.files.get(path);
  if (file !== undefined)
    return buildFileResponse(file, path.startsWith(ASSETS) ? IMMUTABLE : REVALIDATE);
  return path.startsWith(ASSETS) ? undefined : buildFileResponse(bundle.index, REVALIDATE);
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
          isRouteNotFound(cause)
            ? Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
                const response = findBundleResponse(bundle, request);
                return response === undefined ? Effect.failCause(cause) : Effect.succeed(response);
              })
            : Effect.failCause(cause),
        );
