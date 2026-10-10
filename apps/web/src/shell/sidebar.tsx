import { useState, type JSX } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import {
  formatUnseenCount,
  resolveThreadRowsMode,
  type HerculeClient,
  type Live,
} from "@hercule/client-core";
import type { SettingsState } from "@hercule/contract";
import {
  Logo,
  MarksLegend,
  SegmentedControl,
  SegmentedControlItem,
  ThemeSelector,
  cn,
} from "@hercule/ui";
import { useLiveInvalidation } from "../app/live-invalidation";
import { settingsQuery, unseenNotificationsQuery } from "../app/queries";
import { ORCHESTRATION_NAV, SEPARATOR, chooseFaceForPath, type Face, type NavItem } from "./nav";
import { Pulse } from "./pulse";
import { ThreadsFace } from "./threads-face";

/**
 * The count shown beside each nav item that has one, already formatted, such
 * as "3" or "99+". Only the notifications count is filled: nothing counts
 * decisions yet. The check-in count's styling, in the attention hue, is ready
 * for the operation that will fill it.
 */
type Counts = Partial<Record<NonNullable<NavItem["count"]>, string | undefined>>;

/**
 * A count beside a nav item, hidden when it is missing. `attention` draws it
 * in the attention hue, which the check-in count uses wherever it appears.
 */
function Count({
  value,
  attention = false,
}: {
  readonly value: string | undefined;
  readonly attention?: boolean;
}): JSX.Element | null {
  if (value === undefined) return null;
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

/**
 * One item of the orchestration nav. Every item keeps the 12px marker column,
 * empty on the items that carry no glyph, so all labels start at one x: the x
 * of the thread titles, the assistant names and the foot rows.
 */
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
        "flex items-center gap-2 rounded-control px-2.5 py-[5px] text-row",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        active ? "bg-line-soft font-emph text-ink" : "text-muted hover:bg-line-soft",
      )}
    >
      <span className={cn("flex w-3 shrink-0 justify-center", active ? "text-ink" : "text-faint")}>
        {Glyph === undefined ? null : <Glyph className="size-[13px]" />}
      </span>
      {item.label}
      <Count
        value={item.count === undefined ? undefined : counts[item.count]}
        attention={item.count === "checkin"}
      />
    </Link>
  );
}

/**
 * The orchestration nav. It counts the notifications created since the user
 * last opened the notification center, and follows the `notification` topic so
 * the count moves as they arrive. A count that cannot be read shows no count:
 * the notification center says why when the user opens it.
 */
function OrchestrationFace({
  pathname,
  client,
  queryClient,
  live,
}: {
  readonly pathname: string;
  readonly client: HerculeClient;
  readonly queryClient: QueryClient;
  readonly live: Live;
}): JSX.Element {
  useLiveInvalidation(live, queryClient, "notification");
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const unseen = useQuery(
    unseenNotificationsQuery(client, settings.user["lastChecked.notifications"]),
  );
  const counts: Counts = {
    notifications:
      unseen.data === undefined ? undefined : formatUnseenCount(unseen.data.items.length),
  };

  return (
    <nav className="flex flex-col gap-px" aria-label="Hercule">
      {ORCHESTRATION_NAV.map((item, index) =>
        item === SEPARATOR ? (
          // The hairline between the work screens and the machinery behind them.
          <div key={`separator-${String(index)}`} className="mx-2.5 my-2 h-px bg-line-soft" />
        ) : (
          <NavLink
            key={item.to}
            item={item}
            counts={counts}
            active={
              item.section === true
                ? pathname.startsWith("/settings")
                : // A page under a screen's path, such as one workflow's page,
                  // highlights that screen's item.
                  pathname === item.to || pathname.startsWith(`${item.to}/`)
            }
          />
        ),
      )}
    </nav>
  );
}

/**
 * The sidebar, with two faces: threads and orchestration. The current screen
 * picks the face. The segmented switch overrides that choice until the user
 * navigates to another path.
 */
export function Sidebar({
  settings,
  client,
  queryClient,
  live,
}: {
  readonly settings: SettingsState;
  readonly client: HerculeClient;
  readonly queryClient: QueryClient;
  readonly live: Live;
}): JSX.Element {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [override, setOverride] = useState<{ path: string; face: Face } | null>(null);

  const face = override?.path === pathname ? override.face : chooseFaceForPath(pathname);
  const rows = resolveThreadRowsMode(settings.user["ui.threadRows"]);

  return (
    <div className="flex h-dvh w-[244px] shrink-0 flex-col border-r border-line-soft bg-surface px-2.5 pt-3.5 pb-3">
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
        <SegmentedControlItem value="orchestration">Hercule</SegmentedControlItem>
      </SegmentedControl>

      {face === "threads" ? (
        <ThreadsFace
          rows={rows}
          preferredWorkspace={settings.user["thread.workspace"] ?? null}
          client={client}
          queryClient={queryClient}
          live={live}
        />
      ) : (
        <OrchestrationFace
          pathname={pathname}
          client={client}
          queryClient={queryClient}
          live={live}
        />
      )}

      <div className="mt-auto flex flex-col gap-1.5 pt-2.5">
        <Pulse />
        <MarksLegend />
        <ThemeSelector />
      </div>
    </div>
  );
}
