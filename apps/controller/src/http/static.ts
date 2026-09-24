/**
 * Serves the web bundle from the same origin and port as the API.
 *
 * The bundle is `vite build`'s output, embedded in the binary file by file
 * (`./bundle.ts`, generated). Nothing here reads a directory: a compiled
 * binary has no `dist/` on disk, so every file in the bundle is listed up
 * front and read through `Bun.file`, the only reader that understands the
 * embedded filesystem.
 *
 * Serving files is transport, not an operation: it uses no service, records
 * no actor, and writes nothing. It wraps the API application rather than
 * being a route of its own, so **the router still decides what is an API
 * request**. Only a request the router matched no route for can reach the
 * bundle, which keeps `//api/v1/secrets` an API request rather than a deep
 * link.
 *
 * Two more rules apply:
 *
 * - A path under the API prefix is never served from the bundle, so an unknown
 *   operation gets the JSON error envelope instead of HTML.
 * - A path under `/assets/` is a fingerprinted file or a 404. Falling back to
 *   `index.html` there would answer a request for a stale chunk with a page.
 *
 * Every other `GET` is a deep link and gets `index.html`; the router in the
 * browser handles it from there.
 */
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PREFIX } from "@hercule/contract";
import { IDENTITY_PORT, IDENTITY_PORT_COUNT } from "@hercule/protocol";

/**
 * The built web app: the location of its `index.html`, and of every file it
 * can request, keyed by the URL path the browser uses.
 *
 * The values are filesystem paths: `$bunfs/...` in a compiled binary, or a
 * normal path when the controller runs from source.
 */
export interface WebBundle {
  readonly index: string;
  readonly files: ReadonlyMap<string, string>;
}

/**
 * The loopback origins the app may connect to on the user's own machine: the
 * ports a runner's identity listener may use, and no others.
 *
 * They are listed one by one rather than as `127.0.0.1:*`, because a wildcard
 * port would let any script running in this page talk to every service on the
 * user's machine, and this policy exists because such a script must be
 * assumed. The directive can only name a host and a port, so it allows any
 * method and any path on these ten ports, even though the app itself only
 * makes one `GET /identity`.
 */
const IDENTITY_PORTS = Array.from(
  { length: IDENTITY_PORT_COUNT },
  (_, offset) => `http://127.0.0.1:${String(IDENTITY_PORT + offset)}`,
).join(" ");

/**
 * The Content Security Policy: what the browser may load, and where it may
 * connect.
 *
 * The bearer token is stored in `localStorage`, and agent-written text is
 * rendered all over the app, so any script that runs could read the token.
 * The key protection is `script-src 'self'` with no inline scripts, because it
 * stops such a script from running. A policy cannot control where a page
 * navigates, so a script that did run could still send the token away in the
 * address bar. The other directives close every silent channel (a fetch, an
 * image, a font, a frame). The only addresses outside this origin left open
 * are the loopback ports above, where the app asks each runner whether it is
 * on the browser's machine.
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

/** The cache header for fingerprinted files: the name changes when the content does, so they never expire. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** The cache header for every other file, above all `index.html`: revalidate on every load. */
const REVALIDATE = "no-cache";

/** Where Vite puts the fingerprinted files. */
const ASSETS = "/assets/";

/** Matches any path under the API prefix, in any letter case, because the router matches case-insensitively. */
const API_PATH = new RegExp(`^/+${API_PREFIX.slice(1)}(/|$)`, "i");

/** The content type of each file extension the bundle can contain. Anything else is served as bytes. */
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
 * Returns a request's path without the query or the fragment.
 *
 * It slices the string rather than parsing a URL: `new URL("//api/v1/x",
 * base)` reads the leading `//` as a host and returns `/x`, which would turn
 * an API path into a deep link.
 */
const stripQueryAndFragment = (url: string): string => {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
};

/** Checks whether the router matched no route, the only case in which the bundle is used. */
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
      // The browser must use the content type above. A file with an unknown
      // extension is served as bytes, and the browser must not guess that
      // it is a script.
      "x-content-type-options": "nosniff",
    },
  });

/** Returns the bundle's response for a request, or `undefined` when the bundle does not serve it. */
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
 * Wraps `app` so that a request no API route matched is served from the web
 * bundle. A request the bundle does not serve fails as before.
 *
 * With no bundle, such as when the controller runs from a checkout that has
 * not been built, nothing changes: every non-API path is a 404 in the error
 * envelope.
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
