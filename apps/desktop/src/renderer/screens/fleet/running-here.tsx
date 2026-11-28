import { useCallback, useRef, type JSX } from "react";
import { Link, linkOptions } from "@tanstack/react-router";
import type {
  MachineWork,
  MachineWorkGroup,
  MachineWorkSession,
  WorkDestination,
} from "@hercule/client-core/machine-work";
import { useAgeLabel } from "../../app/age-clock";
import { readLengths, useMeasuredAtTextSize } from "../../app/text-size";
import { WorkflowsIcon } from "../../icons/workflows";
import { VirtualList } from "../virtual-list";
import { ViewSwitch } from "../view-switch";
import { MachinePageSection } from "./machine-page-section";
import { MachineFacesStack, MachineWorkFace } from "./work-faces";
import "./running-here.css";

/** The two ways to show the work, in the order the switch lists them. */
export type RunningHereView = "work" | "sessions";

const VIEW_CHOICES = [
  { view: "work", label: "Work" },
  { view: "sessions", label: "Sessions" },
] as const;

/** How many groups, and how many sessions, show before "Show all". */
const SHOWN_GROUPS = 10;
const SHOWN_SESSIONS = 20;

/** Returns the link that opens `destination`. */
const buildDestinationLink = (destination: WorkDestination) => {
  switch (destination.kind) {
    case "thread":
      return linkOptions({
        to: "/threads/$sessionId",
        params: { sessionId: destination.sessionId },
      });
    case "run":
      return linkOptions({ to: "/runs/$runId", params: { runId: destination.runId } });
    case "assistant":
      return linkOptions({
        to: "/assistants/$assistantId",
        params: { assistantId: destination.assistantId },
      });
  }
};

/**
 * The custom property that holds the height of each kind of row, at the
 * default Text size: a group's row (two lines) and a session's (one line).
 * The expanded lists place their rows by these heights, and the rows' CSS
 * draws them at the same properties (styles/row-heights.css).
 */
const ROW_HEIGHT_PROPERTIES = {
  work: "--fleet-running-height-work",
  session: "--fleet-running-height-session",
} as const;

/** Reads the heights of the two kinds of row from the page's CSS, in CSS pixels. */
const readRowHeights = () => readLengths(ROW_HEIGHT_PROPERTIES);

/** A session as an item of the expanded Sessions list, which keys its items. */
interface SessionEntry {
  readonly key: string;
  readonly session: MachineWorkSession;
}

/**
 * Returns the key of the item to focus when the focused item `goneKey` leaves
 * the list: the item that takes its place, or the last one, or `null` when
 * the list is empty.
 */
const pickNeighbourKey = (
  goneKey: string,
  before: ReadonlyArray<{ readonly key: string }>,
  after: ReadonlyArray<{ readonly key: string }>,
): string | null => {
  const index = before.findIndex((item) => item.key === goneKey);
  return after[Math.max(0, Math.min(index, after.length - 1))]?.key ?? null;
};

/**
 * Renders one group's row, a link: its face, title, its kind, its members and its
 * status, its sessions' faces, and since when. Its `data-key` is how the
 * expanded list finds it to keep focus.
 */
function WorkRow({ group }: { readonly group: MachineWorkGroup }): JSX.Element {
  return (
    <Link
      {...buildDestinationLink(group.opens)}
      data-key={group.key}
      className={group.waitingForSlot ? "running-here-row is-waiting" : "running-here-row"}
    >
      <span className="running-here-glyph">
        {group.opens.kind === "run" ? (
          <span className="running-here-icon">
            <WorkflowsIcon size={15} />
          </span>
        ) : (
          <MachineWorkFace face={group.face} size={28} />
        )}
      </span>
      <span className="running-here-text">
        <b>{group.title}</b>
        <span className="running-here-line">
          <span className="running-here-kind">{group.kindLabel}</span>
          {/* The separator is part of the members, so it goes when they do. */}
          {group.memberLabels === "" ? null : (
            <span className="running-here-members"> · {group.memberLabels}</span>
          )}
          <span className="running-here-separator"> · </span>
          <span className="running-here-status">{group.status}</span>
        </span>
      </span>
      <span className="running-here-faces">
        <MachineFacesStack faces={group.faces} size={18} unit="session" />
      </span>
      <span className="running-here-since">{group.since}</span>
    </Link>
  );
}

/**
 * Renders one session of the plain list as a link: its face, title, status,
 * and how long it has run. The runtime is the only part that changes with
 * time, so this item alone draws again when the age clock ticks. `isCounting`
 * is whether the runtime is kept current, which it is only while the item can
 * be seen.
 */
function SessionItem({
  session,
  isCounting,
}: {
  readonly session: MachineWorkSession;
  readonly isCounting: boolean;
}): JSX.Element {
  const runtime = useAgeLabel(session.startedAt, isCounting);
  return (
    <Link
      {...buildDestinationLink(session.opens)}
      data-key={session.id}
      className={
        session.waitingForSlot ? "running-here-session is-waiting" : "running-here-session"
      }
    >
      <MachineWorkFace face={session.face} size={24} />
      <b>{session.title}</b>
      <span className="running-here-status">{session.status}</span>
      <span className="running-here-runtime">{runtime}</span>
    </Link>
  );
}

/**
 * Renders the first `SHOWN_GROUPS` groups as a plain list, before "Show all".
 * Ten rows cost nothing to keep in the page.
 */
function ShortWorkList({ groups }: { readonly groups: readonly MachineWorkGroup[] }): JSX.Element {
  return (
    <ul className="running-here-list running-here-list--work">
      {groups.map((group) => (
        <li key={group.key}>
          <WorkRow group={group} />
        </li>
      ))}
    </ul>
  );
}

/** Renders the first `SHOWN_SESSIONS` sessions as a plain list, in two columns when the section is wide. */
function ShortSessionList({
  sessions,
  isCounting,
}: {
  readonly sessions: readonly MachineWorkSession[];
  readonly isCounting: boolean;
}): JSX.Element {
  return (
    <ul className="running-here-list running-here-list--sessions">
      {sessions.map((session) => (
        <li key={session.id}>
          <SessionItem session={session} isCounting={isCounting} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Renders every group, after "Show all", as a virtualized list in a scroll
 * area of its own: a machine can have a long queue, so the page never holds
 * all the rows (spec 17 §Rules, rule 1). The rows' heights follow the Text
 * size.
 */
function ExpandedWorkList({
  groups,
}: {
  readonly groups: readonly MachineWorkGroup[];
}): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const heights = useMeasuredAtTextSize(readRowHeights);
  const computeItemHeight = useCallback(() => heights.work, [heights]);
  return (
    <VirtualList
      scrollRef={scrollRef}
      className="running-here-scroll"
      aria-label="All the work running here"
      items={groups}
      computeItemHeight={computeItemHeight}
      renderItem={(group) => <WorkRow key={group.key} group={group} />}
      pickFocusFallback={pickNeighbourKey}
    />
  );
}

/**
 * Renders every session, after "Show all", as a virtualized list in a scroll
 * area of its own, in one column: the list places its items one under the
 * other, so it cannot draw the two columns the short list has. A session's
 * runtime is kept current only while its row is in the visible part.
 */
function ExpandedSessionList({
  sessions,
  isCounting,
}: {
  readonly sessions: readonly MachineWorkSession[];
  readonly isCounting: boolean;
}): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const heights = useMeasuredAtTextSize(readRowHeights);
  const computeItemHeight = useCallback(() => heights.session, [heights]);
  const entries = sessions.map((session): SessionEntry => ({ key: session.id, session }));
  return (
    <VirtualList
      scrollRef={scrollRef}
      className="running-here-scroll"
      aria-label="All the sessions running here"
      items={entries}
      computeItemHeight={computeItemHeight}
      renderItem={({ key, session }, _index, onScreen) => (
        <SessionItem key={key} session={session} isCounting={isCounting && onScreen} />
      )}
      pickFocusFallback={pickNeighbourKey}
    />
  );
}

/**
 * Renders the "Running here" section of a machine's page: what runs on the
 * machine now, as groups (`view` "work": one row per run, row of Threads or
 * assistant) or as the plain list of sessions (`view` "sessions"). Every row
 * opens what it is. It draws `work` as given and works out nothing.
 *
 * - Only the first 10 groups, or 20 sessions, show until `isShowingAll`; the
 *   button below them calls `onToggleShowAll`.
 * - After "Show all" the rows are a virtualized list in a scroll area of
 *   their own, about two thirds of the window tall at most, so the page still
 *   scrolls past it. Each view has its own list, drawn afresh at the top when
 *   the view or "Show fewer" brings it back.
 * - A machine with no work shows one line saying so, and no switch.
 * - A group or session that waits for a free slot shows its status in the
 *   marigold ink.
 */
export function RunningHere({
  id,
  work,
  view,
  isShowingAll,
  isCounting,
  onPickView,
  onToggleShowAll,
}: {
  readonly id: string;
  readonly work: MachineWork;
  readonly view: RunningHereView;
  readonly isShowingAll: boolean;
  readonly isCounting: boolean;
  readonly onPickView: (view: RunningHereView) => void;
  readonly onToggleShowAll: () => void;
}): JSX.Element {
  if (work.groups.length === 0) {
    return (
      <MachinePageSection id={id} title="Running here">
        <p className="running-here-empty">Nothing runs here right now.</p>
      </MachinePageSection>
    );
  }
  const limit = view === "work" ? SHOWN_GROUPS : SHOWN_SESSIONS;
  const total = view === "work" ? work.groups.length : work.sessions.length;
  return (
    <MachinePageSection
      id={id}
      title="Running here"
      actions={
        <span className="running-here-view">
          <ViewSwitch
            label="Show the work as"
            choices={VIEW_CHOICES}
            view={view}
            onPick={onPickView}
          />
        </span>
      }
    >
      {view === "work" ? (
        isShowingAll ? (
          <ExpandedWorkList groups={work.groups} />
        ) : (
          <ShortWorkList groups={work.groups.slice(0, limit)} />
        )
      ) : isShowingAll ? (
        <ExpandedSessionList sessions={work.sessions} isCounting={isCounting} />
      ) : (
        <ShortSessionList sessions={work.sessions.slice(0, limit)} isCounting={isCounting} />
      )}
      {total > limit && (
        <button type="button" className="running-here-more" onClick={onToggleShowAll}>
          {isShowingAll ? "Show fewer" : `Show all ${String(total)}`}
        </button>
      )}
    </MachinePageSection>
  );
}
