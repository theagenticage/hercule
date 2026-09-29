/**
 * The origin of the desktop app's page, which its requests carry in the
 * `Origin` header. The page is served from the desktop app's own `app`
 * scheme, so the origin is the same on every machine.
 *
 * The desktop app and the controller both import it from here: the desktop
 * app serves its page at this origin, and the controller allows this one
 * origin in CORS. No web page can have this origin: only an app that
 * registers the `app` scheme itself can use it.
 */
export const DESKTOP_APP_ORIGIN = "app://hercule";
