/**
 * Where the renderer lives. Main serves the renderer's files on its own `app`
 * scheme, under the one host `hercule`, so the page's origin is the contract's
 * `DESKTOP_APP_ORIGIN`, `app://hercule`, in development and in the packaged
 * app alike. Spec 17 (§Reaching the controller) says why the page needs a real
 * origin.
 *
 * This module imports nothing from Electron, so unit tests and every layer can
 * use it.
 */
import { DESKTOP_APP_ORIGIN } from "@hercule/contract";

/**
 * The scheme main registers and serves the renderer on: `app`, the scheme of
 * `DESKTOP_APP_ORIGIN`. A URL's protocol ends with a colon, which a scheme
 * name leaves out.
 */
export const APP_SCHEME = new URL(DESKTOP_APP_ORIGIN).protocol.slice(0, -1);

/** The URL the window loads: the renderer's `index.html`. */
export const RENDERER_URL = `${DESKTOP_APP_ORIGIN}/`;

/**
 * Checks whether `url` is on the renderer's origin. It takes a full URL or a
 * bare origin, and returns false for anything that is not a URL.
 *
 * It compares the scheme and the host rather than `URL.origin`, because
 * Node's `URL` reports the origin of a scheme it does not know, such as
 * `app:`, as "null".
 */
export const isOnRendererOrigin = (url: string): boolean => {
  if (!URL.canParse(url)) return false;
  const { protocol, host } = new URL(url);
  return `${protocol}//${host}` === DESKTOP_APP_ORIGIN;
};
