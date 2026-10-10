/**
 * The last screen, which the app opens again at launch (spec 17 §Native
 * behaviour).
 *
 * Every screen in the shell counts: the new-thread screen, a thread, a
 * subagent's page, an assistant's Conversation, the Office, and each screen
 * added later. Settings, the first run, the connect screen and sign-in do
 * not count. Opening one of them leaves the stored screen as it was, so the
 * Office, then Settings, then a quit reopens the Office.
 *
 * Only the screen's path is kept, never its search params: a launch restores
 * the screen, not a selection on it, such as the thread in the Office's
 * drawer. The path is kept in `localStorage`, one entry per controller URL,
 * because a thread or an assistant means nothing to another controller.
 *
 * A screen opened at launch is marked in its history entry's state. The user
 * did not ask for that screen this time, so when what it shows is gone, its
 * route goes to the new-thread screen instead of showing "not found" (see
 * `throwScreenNotFound`).
 */
import {
  notFound,
  redirect,
  type ParsedLocation,
  type RegisteredRouter,
  type ResolveParams,
} from "@tanstack/react-router";
import { isId, isSubagentId } from "@hercule/contract";
import type { Appearance } from "../../ipc/contract";
import type { FileRouteTypes } from "../routeTree.gen";

/** The id of the shell's layout route, which every counted screen sits under. */
const SHELL_ROUTE_ID = "/_connected/_shell" satisfies FileRouteTypes["id"];

/** The id of Settings' layout route, whose screens do not count. */
const SETTINGS_ROUTE_ID = "/_connected/_shell/settings" satisfies FileRouteTypes["id"];

/**
 * The name of each param in the path of a counted screen. Settings' screens
 * are left out, because they are never stored.
 */
type ScreenParamName<Path = Exclude<FileRouteTypes["fullPaths"], `/settings${string}`>> =
  Path extends string ? keyof ResolveParams<Path> : never;

/**
 * The check each param of a stored path must pass before the path is opened.
 * A path is ordinary text in `localStorage`, so its ids may be corrupted, and
 * the client refuses a malformed id only after a few seconds of retries. A
 * screen added later with a new param fails the typecheck until it has a check.
 */
const SCREEN_PARAM_CHECKS = {
  sessionId: isId,
  assistantId: isId,
  subagentId: isSubagentId,
} satisfies Record<ScreenParamName, (value: string) => boolean>;

/** Returns the `localStorage` key that holds the last screen for `controllerUrl`. */
const buildStorageKey = (controllerUrl: string): string => `last-screen:${controllerUrl}`;

/**
 * Returns the `localStorage` key under which builds before the last screen
 * kept the last open thread's id for `controllerUrl`.
 */
const buildLegacyThreadKey = (controllerUrl: string): string => `last-thread:${controllerUrl}`;

/**
 * Returns the path of the last screen for `controllerUrl`, or `null` when
 * none is stored. A thread id stored by an older build reads as that
 * thread's path, so the first launch after an update still reopens it.
 */
const readLastScreen = (controllerUrl: string): string | null => {
  const path = localStorage.getItem(buildStorageKey(controllerUrl));
  if (path !== null) return path;
  const sessionId = localStorage.getItem(buildLegacyThreadKey(controllerUrl));
  return isId(sessionId) ? `/threads/${sessionId}` : null;
};

/** Stores `path` as the last screen for `controllerUrl`, in place of any older thread id. */
const rememberLastScreen = (controllerUrl: string, path: string): void => {
  localStorage.setItem(buildStorageKey(controllerUrl), path);
  localStorage.removeItem(buildLegacyThreadKey(controllerUrl));
};

/**
 * Checks whether a screen counts as the last screen. `routeIds` are the ids
 * of the routes the screen's path matched, its layout routes included.
 */
const countsAsLastScreen = (routeIds: readonly string[]): boolean =>
  routeIds.includes(SHELL_ROUTE_ID) && !routeIds.includes(SETTINGS_ROUTE_ID);

/**
 * Checks whether `location` is the screen the app opened at launch. Any
 * navigation after launch makes a new history entry, or replaces this one,
 * without the mark.
 */
const isOpenedAtLaunch = (location: Pick<ParsedLocation, "state">): boolean =>
  "openedAtLaunch" in location.state && location.state.openedAtLaunch === true;

/**
 * Checks whether the router went from `from` to `to` by going back or
 * forward through its history. Only that changes the history index without
 * making a new entry: a push makes a new entry, which holds no launch mark,
 * and a replace or a reload keeps the index.
 */
const isHistoryReturn = (from: ParsedLocation | undefined, to: ParsedLocation): boolean =>
  from !== undefined && from.state.__TSR_index !== to.state.__TSR_index;

/**
 * Checks whether `path` leads to a counted screen of `router`, with a valid
 * id for each of the screen's params. A path that leads nowhere, such as one
 * a newer build wrote for a screen this build does not have, does not.
 */
const leadsToCountedScreen = (router: RegisteredRouter, path: string): boolean => {
  // The router matches a path with no leading slash, such as `office`, to the
  // new-thread screen, but then renders nothing at all.
  if (!path.startsWith("/")) return false;
  // The router matches as much of the path as it can. What is left over, such
  // as `old` in `/office/old`, is held in the `**` param, and the router then
  // shows "not found" itself. The app has no route that takes the rest of a
  // path, so a `**` param always means the path leads nowhere.
  const [routes, params, route] = router.getMatchedRoutes(path);
  if (route === undefined || "**" in params) return false;
  const checks: Record<string, (value: string) => boolean> = SCREEN_PARAM_CHECKS;
  if (!Object.entries(params).every(([name, value]) => checks[name]?.(value) === true)) {
    return false;
  }
  // `getMatchedRoutes` types its routes loosely, but every route's id is a string.
  return countsAsLastScreen(routes.map((matched) => matched.id as string));
};

/**
 * Sends `router` to the screen a launch opens for `controllerUrl`:
 *
 * - the Office, when `openOn` is `office`;
 * - otherwise the last screen, when one is stored and its path still leads
 *   to a counted screen;
 * - otherwise the new-thread screen, so the app never opens on a "not found".
 *
 * Call it before the router first loads, and again after a sign-in, because
 * a sign-in comes before the screen a launch opens.
 */
export const openLaunchScreen = (
  router: RegisteredRouter,
  controllerUrl: string,
  openOn: Appearance["openOn"],
): void => {
  const path = openOn === "office" ? "/office" : readLastScreen(controllerUrl);
  const screen = path !== null && leadsToCountedScreen(router, path) ? path : "/";
  router.history.replace(screen, { openedAtLaunch: true });
};

/**
 * Stores each counted screen `router` settles on as the last screen for
 * `controllerUrl`, for as long as the router lives.
 *
 * Quitting the app navigates nowhere, so the screen open at quit stays
 * stored. A screen whose record turns out to be gone is stored as well: the
 * next launch then falls back to the new-thread screen.
 *
 * The screen the app opens at launch is not stored again. It is either the
 * stored screen already, or the Office that Open on asked for, and the
 * Office must not replace the stored screen: switching Open on back to
 * Where I left off still reopens that screen. Going back to that screen
 * later is the user's choice, so it is stored then: its history entry still
 * holds the launch mark, but the arrival is not the launch.
 */
export const trackLastScreen = (router: RegisteredRouter, controllerUrl: string): void => {
  router.subscribe("onResolved", ({ fromLocation, toLocation }) => {
    if (isOpenedAtLaunch(toLocation) && !isHistoryReturn(fromLocation, toLocation)) return;
    if (countsAsLastScreen(router.state.matches.map((match) => match.routeId))) {
      rememberLastScreen(controllerUrl, toLocation.pathname);
    }
  });
};

/**
 * Throws what a screen's loader throws when what the screen shows does not
 * exist, such as a deleted thread:
 *
 * - a redirect to the new-thread screen when the app opened the screen at
 *   launch, because the user did not ask for it this time;
 * - a not-found otherwise, which shows the route's "not found" state.
 *
 * `location` is the location the loader receives.
 */
export const throwScreenNotFound = (location: Pick<ParsedLocation, "state">): never => {
  // The router acts on a thrown `redirect` or `notFound`, which are plain
  // descriptors rather than Errors.
  if (isOpenedAtLaunch(location)) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/", replace: true });
  }
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw notFound();
};
