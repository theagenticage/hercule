import type { JSX } from "react";
import { Link, useMatches, useSearch, type StaticDataRouteOption } from "@tanstack/react-router";
import {
  chooseNewSince,
  FALLBACK_TIMEZONE,
  formatSince,
  formatTimeContext,
  isSupportedTimezone,
} from "@hercule/client-core";
import type { SettingsState } from "@hercule/contract";
import { useMinuteClock } from "@hercule/ui";

/**
 * The top bar: the screen title and the time context.
 *
 * - The title comes from the deepest route match that has one, so a nested
 *   screen sets the title and its layout does not have to.
 * - The time context is the current time in the user's zone. A screen with a
 *   `sinceMarker` shows the time the user last checked instead: the `since`
 *   pinned in its URL, or the stored marker before the screen pins one. It
 *   shows the current time while the user had never checked the screen.
 * - A stored zone this browser cannot format (written by another client, or by
 *   a browser with a newer zone database) falls back to UTC. The bar then shows
 *   a warning that links to the Profile settings, where the zone is set.
 * - A marker that is not a valid date is ignored, and the current time shows
 *   instead. The bar is on every screen in the shell, so it must never be the
 *   reason a screen fails to render.
 * - A screen that draws its own header sets `staticData.ownsTopBar`, and the
 *   bar then hides so the title does not show twice (spec 14 §The thread
 *   surface). The zone warning still shows: no other place renders it, and
 *   without it that screen would show times in the wrong zone with no
 *   explanation.
 */
export function TopBar({ settings }: { readonly settings: SettingsState }): JSX.Element | null {
  const matches = useMatches();
  // The screen's route has already parsed its `since` pin in `validateSearch`.
  const pin = useSearch({ strict: false }).since;
  const now = useMinuteClock();
  const stored = settings.user.timezone ?? FALLBACK_TIMEZONE;
  const known = isSupportedTimezone(stored);
  const timezone = known ? stored : FALLBACK_TIMEZONE;
  const warning = known ? null : (
    <Link
      to="/settings/profile"
      className="truncate text-fine text-attn underline underline-offset-2"
    >
      {`This browser does not know the zone ${stored}; times read in ${FALLBACK_TIMEZONE}.`}
    </Link>
  );

  if (ownsItsTopBar(matches)) {
    return warning === null ? null : <header className="flex px-8 pt-[22px]">{warning}</header>;
  }

  const deepest = [...matches].reverse();
  const framing = deepest.find((match) => match.staticData.title !== undefined);
  const title = framing?.staticData.title ?? "";
  const sinceMarker = framing?.staticData.sinceMarker;
  const lastCheckedAt =
    sinceMarker === undefined ? undefined : chooseNewSince(pin, settings.user[sinceMarker]);
  const since =
    lastCheckedAt === undefined ? undefined : formatSince(new Date(lastCheckedAt), timezone);

  return (
    <header className="flex items-baseline gap-3.5 px-8 pt-[22px]">
      <h1 className="min-w-0 truncate text-title font-emph tracking-[-0.015em] text-ink">
        {title}
      </h1>
      <span className="shrink-0 whitespace-nowrap text-[13px] text-muted">
        {since ?? formatTimeContext(now, timezone)}
      </span>
      {warning}
    </header>
  );
}

/**
 * Checks whether the current screen draws its own top bar. Only the deepest
 * route match counts, because that match is the screen itself; the layouts
 * above it do not decide.
 *
 * A screen that failed to load, or found nothing, shows an error or an empty
 * state instead of its own header. The shell's top bar then shows the title,
 * as it does for every other screen.
 */
export const ownsItsTopBar = (
  matches: ReadonlyArray<{ staticData: StaticDataRouteOption; status: string }>,
) => {
  const screen = matches[matches.length - 1];
  return (
    screen?.staticData.ownsTopBar === true &&
    screen.status !== "error" &&
    screen.status !== "notFound"
  );
};
