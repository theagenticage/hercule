import { useState, type JSX } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { threadRowsMode, type HydraClient, type Live } from "@hydra/client-core";
import type { SettingsState } from "@hydra/contract";
import {
  Logo,
  MarksLegend,
  SegmentedControl,
  SegmentedControlItem,
  ThemeSelector,
  cn,
} from "@hydra/ui";
import { HYDRA_NAV, SEPARATOR, faceForPath, type Face, type NavItem } from "./nav";
import { Pulse } from "./pulse";
import { ThreadsFace } from "./threads-face";

/**
 * What the count slots hold. Nothing counts proposals, decisions or unseen
 * notifications yet, so every slot renders empty; the treatment, including the
 * attention hue the two that carry it use, is in place for the operations that
 * will fill them.
 */
type Counts = Partial<Record<NonNullable<NavItem["count"]>, number>>;

const NO_COUNTS: Counts = {};

/** The attention hue is the check-in count's, wherever that count appears. */
function Count({
  value,
  attention = false,
}: {
  readonly value: number | undefined;
  readonly attention?: boolean;
}): JSX.Element | null {
  if (value === undefined || value === 0) return null;
  return (
    <span
      className={cn(
        "ml-auto font-mono text-[11px] tabular-nums",
        attention ? "text-attn" : "text-faint",
      )}
    >
      {value}
    </span>
  );
}

function NavLink({
  item,
  active,
  counts,
}: {
  readonly item: NavItem;
  readonly active: boolean;
  readonly counts: Counts;
}): JSX.Element {
  const Glyph = item.glyph;
  return (
    <Link
      to={item.to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-control px-2.5 py-[5px] text-row",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        active ? "bg-line-soft font-emph text-ink" : "text-muted hover:bg-line-soft",
      )}
    >
      {Glyph === undefined ? null : (
        <span className={cn("flex w-3.5 justify-center", active ? "text-ink" : "text-faint")}>
          <Glyph className="size-[13px]" />
        </span>
      )}
      {item.label}
      <Count
        value={item.count === undefined ? undefined : counts[item.count]}
        attention={item.count === "checkin"}
      />
    </Link>
  );
}

function HydraFace({
  pathname,
  counts,
}: {
  readonly pathname: string;
  readonly counts: Counts;
}): JSX.Element {
  return (
    <nav className="flex flex-col gap-px" aria-label="Hydra">
      {HYDRA_NAV.map((item, index) =>
        item === SEPARATOR ? (
          // The hairline between the work screens and the machinery behind them.
          <div key={`separator-${String(index)}`} className="mx-2.5 my-2 h-px bg-line-soft" />
        ) : (
          <NavLink
            key={item.to}
            item={item}
            counts={counts}
            active={item.section === true ? pathname.startsWith("/settings") : pathname === item.to}
          />
        ),
      )}
    </nav>
  );
}

/**
 * One sidebar with two faces. The face follows the screen and the switch
 * overrides it for as long as the user stays on that screen: navigating puts
 * the screen back in charge. The check-in count sits on the Hydra segment so
 * the orchestration side never hides while the user works in threads.
 */
export function Sidebar({
  settings,
  client,
  queryClient,
  live,
}: {
  readonly settings: SettingsState;
  readonly client: HydraClient;
  readonly queryClient: QueryClient;
  readonly live: Live;
}): JSX.Element {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [override, setOverride] = useState<{ path: string; face: Face } | null>(null);

  const face = override?.path === pathname ? override.face : faceForPath(pathname);
  const rows = threadRowsMode(settings.user["ui.threadRows"]);

  return (
    <div className="sticky top-0 flex h-dvh w-[244px] shrink-0 flex-col border-r border-line-soft bg-surface px-2.5 pt-3.5 pb-3">
      <div className="flex items-baseline px-2.5 pt-1 pb-3.5 text-lead font-emph text-ink">
        <Logo />
      </div>

      <SegmentedControl
        aria-label="Sidebar face"
        className="mb-3 border-transparent bg-line-soft"
        value={face}
        onValueChange={(next) => {
          setOverride({ path: pathname, face: next as Face });
        }}
      >
        <SegmentedControlItem value="threads">Threads</SegmentedControlItem>
        <SegmentedControlItem
          value="hydra"
          className="inline-flex items-center justify-center gap-1.5"
        >
          Hydra
          <Count value={NO_COUNTS.checkin} attention />
        </SegmentedControlItem>
      </SegmentedControl>

      {face === "threads" ? (
        <ThreadsFace rows={rows} client={client} queryClient={queryClient} live={live} />
      ) : (
        <HydraFace pathname={pathname} counts={NO_COUNTS} />
      )}

      <div className="mt-auto flex flex-col gap-1.5 pt-2.5">
        <Pulse />
        <MarksLegend />
        <ThemeSelector />
      </div>
    </div>
  );
}
