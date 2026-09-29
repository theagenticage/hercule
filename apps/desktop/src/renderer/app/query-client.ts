import { QueryClient } from "@tanstack/react-query";

/**
 * Creates the app's query cache.
 *
 * Reads and writes run whether or not Chromium reports the Mac online. By
 * default, Query pauses them while the Mac is offline, but the controller is
 * often on the Mac itself or on the local network, and still answers then.
 *
 * Queries keep Query's default `gcTime` of 5 minutes. A query that loses its
 * last screen then sets one timeout, which removes it, so the cache stays
 * small in an app whose window hides rather than closes. That timeout follows
 * a user's action, so the app still does no work while idle.
 *
 * A finished mutation holds nothing a screen reads again, so it is removed as
 * soon as no screen shows it.
 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: { networkMode: "always" },
      mutations: { gcTime: 0, networkMode: "always" },
    },
  });
