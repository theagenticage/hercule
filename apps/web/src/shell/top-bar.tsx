import type { JSX } from "react";
import { Link, useMatches, type StaticDataRouteOption } from "@tanstack/react-router";
import {
  FALLBACK_TIMEZONE,
  formatSince,
  formatTimeContext,
  isSupportedTimezone,
} from "@hydra/client-core";
import type { SettingsState } from "@hydra/contract";
import { useMinuteClock } from "@hydra/ui";

/**
 * The screen title and its time context.
 *
 * The title comes from the deepest match that names one, so a nested screen
 * titles the bar and its layout does not have to. The time context is the
 * user's own zone throughout: a screen framed on when the user last looked says
 * so instead, and falls back to the plain reading until that marker exists.
 *
 * A stored zone this browser cannot format - written by another client, or by
 * a browser whose zone database is newer - is read in UTC and said so, with
 * the screen that fixes it one click away. A marker that is not a date says
 * nothing at all, and the plain clock stands in its place. The bar is on every
 * screen inside the shell, so it is the one place that must never be the
 * reason nothing renders.
 *
 * A screen that renders its own chrome says so with `staticData.ownsTopBar`,
 * and the bar stands down rather than titling the screen twice (spec 14 §The
 * thread surface).
 */
export function TopBar({ settings }: { readonly settings: SettingsState }): JSX.Element | null {
  const matches = useMatches();
  const now = useMinuteClock();
  if (ownsItsTopBar(matches)) return null;

  const deepest = [...matches].reverse();
  const framing = deepest.find((match) => match.staticData.title !== undefined)?.staticData;
  const title = framing?.title ?? "";
  const stored = settings.user.timezone ?? FALLBACK_TIMEZONE;
  const known = isSupportedTimezone(stored);
  const timezone = known ? stored : FALLBACK_TIMEZONE;
  const marker =
    framing?.sinceMarker === undefined ? undefined : settings.user[framing.sinceMarker];
  const since = marker === undefined ? undefined : formatSince(new Date(marker), timezone);

  return (
    <header className="flex items-baseline gap-3.5 px-8 pt-[22px]">
      <h1 className="min-w-0 truncate text-title font-emph tracking-[-0.015em] text-ink">
        {title}
      </h1>
      <span className="shrink-0 whitespace-nowrap text-[13px] text-muted">
        {since ?? formatTimeContext(now, timezone)}
      </span>
      {known ? null : (
        <Link
          to="/settings/profile"
          className="truncate text-fine text-attn underline underline-offset-2"
        >
          {`This browser does not know the zone ${stored}; times read in ${FALLBACK_TIMEZONE}.`}
        </Link>
      )}
    </header>
  );
}

/**
 * Whether the screen on screen renders its own chrome. The deepest match is
 * the screen itself, so a layout above it never answers for it.
 */
export const ownsItsTopBar = (matches: ReadonlyArray<{ staticData: StaticDataRouteOption }>) =>
  matches[matches.length - 1]?.staticData.ownsTopBar === true;
