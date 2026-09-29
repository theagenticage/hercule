/**
 * Where a request on the `app` scheme goes in development, when main forwards
 * the renderer's requests to its Vite dev server.
 */
import { isOnRendererOrigin } from "./renderer-origin";

/**
 * Builds the URL on the dev server at `devServerUrl` that a request for
 * `requestUrl`, a URL on the `app` scheme, is forwarded to: the dev server's
 * origin with the request's path and query string.
 *
 * Returns null when the request is not on the renderer's origin, or when the
 * URL built would not be on the dev server's origin. Resolving the request's
 * path against the dev server's URL could leave it: `//elsewhere.example/x`
 * resolves to another host. Setting the path cannot, and the check makes sure
 * of it.
 */
export const buildDevServerUrl = (devServerUrl: string, requestUrl: string): string | null => {
  if (!isOnRendererOrigin(requestUrl)) return null;
  const { origin } = new URL(devServerUrl);
  const { pathname, search } = new URL(requestUrl);
  const target = new URL(origin);
  target.pathname = pathname;
  target.search = search;
  return target.origin === origin ? target.toString() : null;
};
