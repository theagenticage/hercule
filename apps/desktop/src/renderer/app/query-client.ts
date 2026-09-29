import { QueryClient } from "@tanstack/react-query";

/**
 * Creates the app's query cache.
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
  new QueryClient({ defaultOptions: { mutations: { gcTime: 0 } } });
