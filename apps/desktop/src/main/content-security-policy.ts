/**
 * The Content-Security-Policy main sends with every file of the renderer.
 * Spec 17 (§Content-Security-Policy) owns the policy; this module builds it.
 */

/** Returns the WebSocket origin that goes with an http or https URL: `ws:` or `wss:`, same host. */
const buildWebSocketOrigin = (url: URL): string =>
  `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;

/** Returns the origins the page may connect to at `url`: its HTTP origin and its WebSocket origin. */
const buildConnectSources = (url: string): ReadonlyArray<string> => {
  const parsed = new URL(url);
  return [parsed.origin, buildWebSocketOrigin(parsed)];
};

/**
 * Builds the renderer's Content-Security-Policy.
 *
 * - `controllerUrl` is the saved controller's URL, or `null` before one is
 *   saved. The page may connect to that controller's origin, over HTTP and
 *   over its WebSocket, and nowhere else. With no controller it may connect
 *   nowhere: `connect-src 'none'`.
 * - `devServerUrl` is the renderer's Vite dev server in development, and
 *   `null` in the packaged app. In development the page also connects to the
 *   dev server for hot reloading, and runs the inline script and styles Vite
 *   injects. The packaged app never allows either.
 *
 * Both URLs must be http or https URLs. The settings only ever hold such a
 * URL, and the dev script always passes one.
 */
export const buildContentSecurityPolicy = (
  controllerUrl: string | null,
  devServerUrl: string | null,
): string => {
  const connectSources = [
    ...(controllerUrl === null ? [] : buildConnectSources(controllerUrl)),
    ...(devServerUrl === null ? [] : buildConnectSources(devServerUrl)),
  ];
  const inline = devServerUrl === null ? "" : " 'unsafe-inline'";
  return [
    "default-src 'self'",
    `script-src 'self'${inline}`,
    `connect-src ${connectSources.length === 0 ? "'none'" : connectSources.join(" ")}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `style-src 'self'${inline}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
};
