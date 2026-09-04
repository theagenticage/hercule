import type { JSX } from "react";
import { useMatches } from "@tanstack/react-router";
import { formatSince, formatTimeContext } from "@hydra/client-core";
import type { SettingsState } from "@hydra/contract";
import { useMinuteClock } from "./clock";

/**
 * The screen title and its time context.
 *
 * The title comes from the deepest match that names one, so a nested screen
 * titles the bar and its layout does not have to. The time context is the
 * user's own zone throughout: a screen framed on when the user last looked says
 * so instead, and falls back to the plain reading until that marker exists.
 */
export function TopBar({ settings }: { readonly settings: SettingsState }): JSX.Element {
  const matches = useMatches();
  const now = useMinuteClock();

  const framing = [...matches]
    .reverse()
    .find((match) => match.staticData.title !== undefined)?.staticData;
  const timezone = settings.user.timezone ?? "UTC";
  const since = framing?.sinceMarker === undefined ? undefined : settings.user[framing.sinceMarker];

  return (
    <header className="flex items-baseline gap-3.5 px-8 pt-[22px]">
      <h1 className="shrink-0 truncate text-title font-emph tracking-[-0.015em] text-ink">
        {framing?.title ?? ""}
      </h1>
      <span className="whitespace-nowrap text-[13px] text-muted">
        {since === undefined
          ? formatTimeContext(now, timezone)
          : formatSince(new Date(since), timezone)}
      </span>
    </header>
  );
}
