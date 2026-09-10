import type { JSX } from "react";
import { Link, useMatches } from "@tanstack/react-router";
import {
  FALLBACK_TIMEZONE,
  formatSince,
  formatTimeContext,
  isSupportedTimezone,
} from "@hydra/client-core";
import type { SettingsState } from "@hydra/contract";
import { useMinuteClock } from "@hydra/ui";
import { isRouteCrumb } from "../app/router";

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
 * A route whose loader hands back a `RouteCrumb` (a thread's own title and its
 * `thread · <id>` crumb) is shown instead of the plain screen title: the deepest
 * match wins, the same rule the static title itself follows.
 */
export function TopBar({ settings }: { readonly settings: SettingsState }): JSX.Element {
  const matches = useMatches();
  const now = useMinuteClock();

  const deepest = [...matches].reverse();
  const framing = deepest.find((match) => match.staticData.title !== undefined)?.staticData;
  const crumb = deepest.find((match) => isRouteCrumb(match.loaderData))?.loaderData;
  const title = isRouteCrumb(crumb) ? crumb.title : (framing?.title ?? "");
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
      {isRouteCrumb(crumb) ? (
        <span className="shrink-0 font-mono text-fine text-faint tabular-nums">{crumb.crumb}</span>
      ) : null}
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
