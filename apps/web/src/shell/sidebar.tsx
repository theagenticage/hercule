import { useState, type JSX } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { threadRowsMode } from "@hydra/client-core";
import type { SettingsState, ThreadRows } from "@hydra/contract";
import { Logo, MarksLegend, SegmentedControl, SegmentedControlItem, cn } from "@hydra/ui";
import { HYDRA_NAV, SEPARATOR, faceForPath, type Face, type NavItem } from "./nav";
import { Pulse } from "./pulse";

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
 * The threads face: the thread list and the one button that starts a thread.
 * Neither has an operation behind it yet, so the button is disabled with its
 * reason under it rather than hidden, and the list says it is empty.
 *
 * The row density is the seam the thread list is built on: what a row shows is
 * this setting's to say, and the list reads it from here.
 */
function ThreadsFace({ rows }: { readonly rows: ThreadRows }): JSX.Element {
  return (
    <nav aria-label="Threads" className="flex min-h-0 flex-col">
      <button
        type="button"
        disabled
        className="mb-2.5 flex w-full items-center gap-2 rounded-control border border-line bg-raised px-2.5 py-1.5 text-left text-row font-emph text-ink shadow-card disabled:opacity-50"
      >
        <span className="font-mono text-row text-faint">+</span>
        Create new thread
      </button>
      <div data-thread-rows={rows} className="min-h-0 overflow-auto">
        <p className="px-2.5 py-1 text-fine text-faint">No threads yet</p>
        <p className="px-2.5 pt-1 text-fine text-faint">
          A thread needs a runner with a provider login on it.
        </p>
      </div>
    </nav>
  );
}

/**
 * One sidebar with two faces. The face follows the screen and the switch
 * overrides it for as long as the user stays on that screen: navigating puts
 * the screen back in charge. The check-in count sits on the Hydra segment so
 * the orchestration side never hides while the user works in threads.
 */
export function Sidebar({ settings }: { readonly settings: SettingsState }): JSX.Element {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [override, setOverride] = useState<{ path: string; face: Face } | null>(null);

  const face = override?.path === pathname ? override.face : faceForPath(pathname);
  const rows = threadRowsMode(settings.user["ui.threadRows"]);

  return (
    <div className="sticky top-0 flex h-dvh w-[236px] shrink-0 flex-col border-r border-line-soft bg-surface px-2.5 pt-3.5 pb-3">
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
        <ThreadsFace rows={rows} />
      ) : (
        <HydraFace pathname={pathname} counts={NO_COUNTS} />
      )}

      <div className="mt-auto flex flex-col gap-1.5 pt-2.5">
        <Pulse />
        <MarksLegend />
      </div>
    </div>
  );
}
