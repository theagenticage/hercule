import type { JSX } from "react";
import { Link, linkOptions } from "@tanstack/react-router";
import type {
  MachineWork,
  MachineWorkGroup,
  MachineWorkSession,
  WorkDestination,
} from "@hercule/client-core/machine-work";
import { useAgeLabel } from "../../app/age-clock";
import { WorkflowsIcon } from "../../icons/workflows";
import { ViewSwitch } from "../workflows/view-switch";
import { MachinePageSection } from "./machine-page-section";
import { MachineWorkFace } from "./work-faces";
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

/** Renders one group: its face, title, what it is and its status, its sessions' faces, and since when. */
function WorkRow({ group }: { readonly group: MachineWorkGroup }): JSX.Element {
  return (
    <li>
      <Link
        {...buildDestinationLink(group.opens)}
        className={group.waitingForSlot ? "running-here-row is-waiting" : "running-here-row"}
      >
        <span className="running-here-glyph">
          {group.kind === "run" ? (
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
            <span className="running-here-detail">{group.detail}</span>
            <span className="running-here-separator"> · </span>
            <span className="running-here-status">{group.status}</span>
          </span>
        </span>
        <span className="running-here-faces">
          {group.faces.map((face, index) => (
            <MachineWorkFace key={index} face={face} size={18} />
          ))}
        </span>
        <span className="running-here-since">{group.since}</span>
      </Link>
    </li>
  );
}

/**
 * Renders one session of the plain list: its face, title, status, and how
 * long it has run. The runtime is the only part that changes with time, so
 * this item alone draws again when the age clock ticks. `isCounting` is
 * whether the runtime is kept current, which it is only while the window can
 * be seen.
 */
function SessionItem({
  session,
  isCounting,
}: {
  readonly session: MachineWorkSession;
  readonly isCounting: boolean;
}): JSX.Element {
  const runtime = useAgeLabel(session.runningSince, isCounting);
  return (
    <li>
      <Link
        {...buildDestinationLink(session.opens)}
        className={
          session.waitingForSlot ? "running-here-session is-waiting" : "running-here-session"
        }
      >
        <MachineWorkFace face={session.face} size={24} />
        <b>{session.title}</b>
        <span className="running-here-status">{session.status}</span>
        <span className="running-here-runtime">{runtime}</span>
      </Link>
    </li>
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
 * - A machine with no work shows one line saying so, and no switch.
 * - A group or session that waits for a free slot is drawn in the marigold
 *   ink, with its faces dimmed.
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
  const shown = isShowingAll ? total : Math.min(total, limit);
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
        <ul className="running-here-list running-here-list--work">
          {work.groups.slice(0, shown).map((group) => (
            <WorkRow key={group.key} group={group} />
          ))}
        </ul>
      ) : (
        <ul className="running-here-list running-here-list--sessions">
          {work.sessions.slice(0, shown).map((session) => (
            <SessionItem key={session.id} session={session} isCounting={isCounting} />
          ))}
        </ul>
      )}
      {total > limit && (
        <button type="button" className="running-here-more" onClick={onToggleShowAll}>
          {isShowingAll ? "Show fewer" : `Show all ${String(total)}`}
        </button>
      )}
    </MachinePageSection>
  );
}
