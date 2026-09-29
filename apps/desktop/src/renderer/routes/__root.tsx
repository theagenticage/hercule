import { createRootRoute, Outlet } from "@tanstack/react-router";

/**
 * The root route. It renders only the matched child route: the screens inside
 * the app sit under the `_shell` layout route, and the screens before it, such
 * as connecting to a controller, will sit beside that route, outside the
 * shell.
 */
export const Route = createRootRoute({ component: Outlet });
