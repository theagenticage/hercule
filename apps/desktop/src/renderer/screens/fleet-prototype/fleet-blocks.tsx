/**
 * PROTOTYPE - throwaway. The blocks round 2 of the Fleet prototype builds
 * with: B's machine card and machine page, grown up, and C's three concerns
 * as panels that work for the whole fleet. Variants D, E and F arrange them
 * differently; the blocks themselves are the same, so the variants differ
 * only in structure.
 *
 * New ideas here, beyond round 1:
 * - Room for more: every machine says how many more sessions it can start,
 *   and which of slots, memory or disk stops it.
 * - Trends: disk use over 14 days with a forecast to its limit, and sessions
 *   over the last 24 hours.
 * - The baseline: every tool is kept newest, pinned, or left alone, and one
 *   review applies every update that brings the machines to those versions.
 * - Who is here: the faces of the colleagues working on each machine.
 * - What happened: a short activity log per machine.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { Face } from "../../faces";
import { buildAssistantLook, buildSessionLook } from "../../faces/look";
import { WorkflowsIcon } from "../../icons/workflows";
import { QuestionIcon } from "../../icons/question";
import { CheckIcon } from "../../icons/check";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { ExternalIcon } from "../../icons/external";
import { MoreIcon } from "../../icons/more";
import { PlusIcon } from "../../icons/plus";
import { GlassDialog } from "../glass-dialog";
import {
  DiskBar,
  MAX_SLOT_BLOCKS,
  SessionBar,
  describeState,
  MachineIcon,
  Meter,
  ProjectDot,
  SlotPips,
  StatusDot,
  Swatch,
  ToolButton,
  ToolMark,
} from "./fleet-atoms";
import {
  applyChanges,
  autoCleanTargets,
  buildChanges,
  buildDiskParts,
  computeHeadroom,
  daysUntilFull,
  describeLimit,
  diskLevel,
  diskShare,
  findIssues,
  formatDays,
  formatGB,
  idleWorkspaces,
  isAway,
  memoryLevel,
  memoryShare,
  readHistory,
  readToolStatus,
  findNewest,
  setAutoClean,
  setDraining,
  setPolicy,
  setSlots,
  slotsLevel,
  suggestSlots,
  TOOL_NEWS,
  TOOLS,
  toolKey,
  useFleet,
  type AutoClean,
  type Change,
  type FleetState,
  type Level,
  type Machine,
  type MachineId,
  type Policy,
  type Tool,
  type ActivityEntry,
  type WorkSession,
  type Workload,
  installTool,
  canInstall,
  findLastSweep,
  signIn,
  PROVIDER_ACCOUNTS,
} from "./fleet-world";
import "../session/floating-header.css";
import "../settings/settings.css";
import "./fleet-blocks.css";

export type Concern = "capacity" | "storage" | "software";

export const worstLevel = (machine: Machine): Level => {
  if (isAway(machine)) return "crit";
  const levels = [diskLevel(machine), memoryLevel(machine), slotsLevel(machine)];
  return levels.includes("crit") ? "crit" : levels.includes("warn") ? "warn" : "ok";
};

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six"];

/** The sentence that leads the fleet: how many machines need you, and how much room is left. */
export function FleetLead({ fleet }: { readonly fleet: FleetState }): JSX.Element {
  const needy = new Set(findIssues(fleet).map((issue) => issue.machineId));
  const online = fleet.machines.filter((each) => !isAway(each));
  const running = online.reduce((sum, each) => sum + each.running, 0);
  const room = online.reduce((sum, each) => sum + computeHeadroom(each).room, 0);
  const waiting = online.reduce((sum, each) => sum + each.queued, 0);
  return (
    <header className="fx-lead">
      <h2>
        {needy.size === 0
          ? "Every machine is healthy."
          : `${NUMBER_WORDS[needy.size] ?? needy.size} ${needy.size === 1 ? "machine needs" : "machines need"} you.`}
      </h2>
      <p>
        <b>{running}</b> sessions running on {online.length} machines
        {waiting > 0 && (
          <>
            , <b className="is-you">{waiting} waiting</b>
          </>
        )}
        . Room for <b>{room}</b> more right now.
      </p>
    </header>
  );
}

/**
 * Returns what the controller lacks today to show `tool`'s version: the
 * runner reports git's and gh's versions, and the provider probe each
 * harness's, so the other toolchains need a new probe.
 */
const readsNeeds = (tool: Tool): string | undefined =>
  tool.kind === "toolchain" && tool.id !== "git" && tool.id !== "gh" ? "new probe" : undefined;

// ---------- Small drawings ----------

/**
 * Returns the bottom of a disk trend's scale: a little under its lowest
 * point, so a slope reads, while the limit at the top stays in view.
 */
export const zoomFloor = (used: ReadonlyArray<number>, ceiling: number): number => {
  const low = Math.min(...used);
  return Math.max(0, low - (ceiling - low) * 0.6);
};

/**
 * A line over time. `values` run oldest first. With `ceiling`, a dashed red
 * line marks the limit, and with `forecast`, a dashed line carries the trend
 * on by that many steps.
 */
export function Sparkline({
  values,
  max,
  min = 0,
  ceiling,
  forecast = 0,
  height = 28,
  tone = "ink",
}: {
  readonly values: ReadonlyArray<number>;
  readonly max: number;
  readonly min?: number;
  readonly ceiling?: number | undefined;
  readonly forecast?: number;
  readonly height?: number;
  readonly tone?: "ink" | "you";
}): JSX.Element {
  const steps = values.length - 1 + forecast;
  const x = (index: number) => (index / steps) * 100;
  const y = (value: number) =>
    height - ((Math.min(value, max) - min) / (max - min)) * (height - 2) - 1;
  const line = values
    .map((value, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(value)}`)
    .join(" ");
  const last = values.at(-1)!;
  const slope = (last - values[0]!) / (values.length - 1);
  const projected = last + slope * forecast;
  return (
    <span className="fx-spark-wrap" data-needs="history">
      <svg
        className={`fx-spark fx-spark--${tone}`}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        height={height}
        aria-hidden="true"
      >
        <path
          className="fx-spark-area"
          d={`${line} L${x(values.length - 1)},${height} L0,${height} Z`}
        />
        <path className="fx-spark-line" d={line} />
        {forecast > 0 && (
          <path
            className="fx-spark-forecast"
            d={`M${x(values.length - 1)},${y(last)} L${x(steps)},${y(projected)}`}
          />
        )}
        {ceiling !== undefined && (
          <path className="fx-spark-ceiling" d={`M0,${y(ceiling)} L100,${y(ceiling)}`} />
        )}
      </svg>
    </span>
  );
}

/** Sessions over the last 24 hours, a bar per half hour, marigold where threads waited. */
export function DayStrip({
  machine,
  tall = false,
}: {
  readonly machine: Machine;
  readonly tall?: boolean;
}): JSX.Element {
  const history = readHistory(machine);
  return (
    <span className={tall ? "fx-day is-tall" : "fx-day"} aria-hidden="true" data-needs="history">
      {history.sessions.map((count, index) => (
        <i
          key={index}
          className={history.waiting[index]! > 0 ? "is-wait" : undefined}
          style={{
            height: count === 0 ? "1.5px" : `${Math.max(12, (count / machine.slots) * 100)}%`,
          }}
        />
      ))}
    </span>
  );
}

/**
 * A machine's sessions against its cap. Filled pips run and hollow pips are
 * free; after the cap's rule, marigold pips are threads waiting for a slot.
 * Past 16 slots it is one bar, cut every 10 sessions.
 */
export function Ladder({ machine }: { readonly machine: Machine }): JSX.Element {
  const away = isAway(machine);
  const free = Math.max(0, machine.slots - machine.running);
  if (machine.slots > MAX_SLOT_BLOCKS) {
    return (
      <span className="fx-ladder is-bar">
        <SessionBar
          slots={machine.slots}
          running={away ? 0 : machine.running}
          waiting={machine.queued}
          away={away}
          height={18}
        />
      </span>
    );
  }
  return (
    <span className={away ? "fx-ladder is-away" : "fx-ladder"} aria-hidden="true">
      {Array.from({ length: machine.running }, (_, index) => (
        <i key={`r${index}`} className="is-run" />
      ))}
      {Array.from({ length: free }, (_, index) => (
        <i key={`f${index}`} />
      ))}
      {machine.queued > 0 && <b className="fx-cap" />}
      {Array.from({ length: machine.queued }, (_, index) => (
        <i key={`w${index}`} className="is-wait" />
      ))}
    </span>
  );
}

/** The faces of the colleagues working on `machine`, overlapping, then how many more. */
export function FacesStack({
  fleet,
  machine,
  size = 20,
  shown = 5,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly size?: number;
  readonly shown?: number;
}): JSX.Element | null {
  const sessions = fleet.workloads
    .filter((each) => each.machineId === machine.id)
    .flatMap((workload) => workload.sessions.map((session) => ({ session, workload })))
    .filter(({ session }) => session.state !== "queued");
  if (sessions.length === 0) return null;
  return (
    <span
      className="fx-faces"
      style={{ "--fx-face": `${size}px` } as CSSProperties}
      title={`${sessions.length} sessions`}
    >
      {sessions.slice(0, shown).map(({ session }) => (
        <span key={session.id} className="fx-face">
          <SessionFace session={session} size={size} />
        </span>
      ))}
      {sessions.length > shown && <small>+{sessions.length - shown}</small>}
    </span>
  );
}

/**
 * The one line a card ends with: what needs you, with its fix, or that all
 * is well. `compact` leaves out what a list's other columns already show,
 * such as the disk's forecast.
 */
export function AttentionLine({
  fleet,
  machine,
  onCleanup,
  compact = false,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly onCleanup: () => void;
  readonly compact?: boolean;
}): JSX.Element {
  const disk = diskLevel(machine);
  const days = daysUntilFull(machine);
  const parts = buildDiskParts(machine, fleet.workspaces);
  const pendingSlots = fleet.pending.has(`slots:${machine.id}`);
  const outOfLine = buildChanges(fleet).filter((change) => change.machine.id === machine.id).length;
  if (isAway(machine)) {
    return (
      <span className="fx-attn is-fail">
        {compact
          ? `${machine.pinned} threads wait for it`
          : `${machine.lostContact ? "Stopped answering" : "Offline"} ${machine.lastSeen} · ${machine.pinned} threads wait`}
      </span>
    );
  }
  if (disk !== "ok") {
    return (
      <>
        <span
          className="fx-attn is-you"
          data-needs={compact ? "workspace sizes" : "history · workspace sizes"}
        >
          {compact
            ? `${formatGB(parts.idle)} idle`
            : `${days !== null ? `Disk full in ~${days} days` : "Disk nearly full"} · ${formatGB(parts.idle)} idle`}
        </span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={(event) => (event.stopPropagation(), onCleanup())}
        >
          Clean up…
        </button>
      </>
    );
  }
  if (machine.queued > 0) {
    const suggested = suggestSlots(machine);
    return (
      <>
        <span className="fx-attn is-you">
          {compact ? `${machine.queued} waiting` : `${machine.queued} threads waiting for a slot`}
        </span>
        <button
          type="button"
          className="btn btn--sm"
          aria-disabled={pendingSlots || undefined}
          onClick={(event) => {
            event.stopPropagation();
            void setSlots(machine.id, suggested);
          }}
        >
          {pendingSlots ? (
            <>
              <span className="spin" /> Saving…
            </>
          ) : (
            `Allow ${suggested}`
          )}
        </button>
      </>
    );
  }
  return (
    <span className="fx-attn">
      {outOfLine > 0
        ? `${outOfLine} ${outOfLine === 1 ? "update" : "updates"} waiting`
        : "Nothing needs you"}
    </span>
  );
}

// ---------- The machine card ----------

/**
 * B's card, grown up: its three gauges, who is working there with how much
 * room is left, and the one thing that needs you. `onGauge`, when given,
 * makes each gauge a way into its concern.
 */
export function MachineCard({
  fleet,
  machine,
  onOpen,
  onCleanup,
  onGauge,
  isOn = false,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly onOpen: () => void;
  readonly onCleanup: () => void;
  readonly onGauge?: ((concern: Concern) => void) | undefined;
  readonly isOn?: boolean;
}): JSX.Element {
  const away = isAway(machine);
  const disk = away ? "ok" : diskLevel(machine);
  const memory = memoryLevel(machine);
  const headroom = computeHeadroom(machine);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`fx-card${away ? " is-away" : ""}${isOn ? " is-on" : ""}`}
      style={{ viewTransitionName: `fx-card-${machine.id}` } as CSSProperties}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      <CardHead machine={machine} />
      <div className="fx-gauges">
        <Gauge
          label="Sessions"
          value={away ? "—" : String(machine.running)}
          unit={away ? "" : `/${machine.slots}`}
          level={machine.queued > 0 ? "warn" : "ok"}
          onClick={onGauge === undefined ? undefined : () => onGauge("capacity")}
        >
          <SlotPips machine={machine} />
        </Gauge>
        <Gauge
          label="Disk"
          value={String(Math.round(diskShare(machine) * 100))}
          unit="%"
          level={disk}
          needs="disk total"
          onClick={onGauge === undefined ? undefined : () => onGauge("storage")}
        >
          <Meter value={diskShare(machine)} level={disk} />
        </Gauge>
        <Gauge
          label="Memory"
          value={away ? "—" : String(Math.round(memoryShare(machine) * 100))}
          unit={away ? "" : "%"}
          level={memory}
          onClick={onGauge === undefined ? undefined : () => onGauge("capacity")}
        >
          <Meter value={away ? 0 : memoryShare(machine)} level={memory} />
        </Gauge>
      </div>
      <div className="fx-card-crew">
        <FacesStack fleet={fleet} machine={machine} />
        <span className="fx-room">
          {away
            ? "Last known values"
            : headroom.room === 0
              ? "No room for more"
              : `Room for ${headroom.room} more`}
        </span>
      </div>
      <div className="fx-card-foot">
        <AttentionLine fleet={fleet} machine={machine} onCleanup={onCleanup} />
      </div>
    </div>
  );
}

export function CardHead({ machine }: { readonly machine: Machine }): JSX.Element {
  const away = isAway(machine);
  return (
    <div className="fx-card-h">
      <span
        className="fx-card-icon"
        style={{ viewTransitionName: `fx-icon-${machine.id}` } as CSSProperties}
      >
        <MachineIcon machine={machine} size={16} />
      </span>
      <span className="fx-card-name">
        <b style={{ viewTransitionName: `fx-name-${machine.id}` } as CSSProperties}>
          {machine.name}
        </b>
        <span>
          {machine.isLocal ? "This Mac · " : ""}
          {machine.model}
        </span>
      </span>
      <span className="fx-card-state">
        <StatusDot
          machine={machine}
          level={worstLevel(machine) === "crit" && !away ? "crit" : worstLevel(machine)}
        />
        {away
          ? machine.lostContact
            ? "Unreachable"
            : "Offline"
          : machine.lifecycle === "draining"
            ? "Draining"
            : "Online"}
      </span>
    </div>
  );
}

function Gauge({
  label,
  value,
  unit,
  level,
  onClick,
  needs,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly level: Level;
  readonly onClick: (() => void) | undefined;
  /** PROTOTYPE: what the controller lacks today to show this gauge. */
  readonly needs?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const content = (
    <>
      <span className="fx-gauge-label">{label}</span>
      <b>
        {value}
        <small>{unit}</small>
      </b>
      {children}
    </>
  );
  return onClick === undefined ? (
    <div className={`fx-gauge fx-gauge--${level}`} data-needs={needs}>
      {content}
    </div>
  ) : (
    <button
      type="button"
      className={`fx-gauge fx-gauge--${level} is-link`}
      data-needs={needs}
      title={`${label} in detail`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {content}
    </button>
  );
}

// ---------- The concerns, for the whole fleet ----------

export function PanelHead({
  title,
  lead,
  aside,
}: {
  readonly title: string;
  readonly lead: ReactNode;
  readonly aside?: ReactNode;
}): JSX.Element {
  return (
    <div className="fx-panel-h">
      <div>
        <h2>{title}</h2>
        <p>{lead}</p>
      </div>
      {aside}
    </div>
  );
}

export function MachineLabel({
  machine,
  onOpen,
}: {
  readonly machine: Machine;
  readonly onOpen?: (() => void) | undefined;
}): JSX.Element {
  const content = (
    <>
      <StatusDot
        machine={machine}
        level={worstLevel(machine) === "crit" && !isAway(machine) ? "crit" : worstLevel(machine)}
      />
      <b>{machine.name}</b>
    </>
  );
  return onOpen === undefined ? (
    <span className="fx-mlabel">{content}</span>
  ) : (
    <button type="button" className="fx-mlabel is-link" onClick={onOpen}>
      {content}
    </button>
  );
}

/** Capacity across the fleet: every machine's ladder, its last day, and its room. */
export function CapacityPanel({
  fleet,
  highlight,
  onOpen,
}: {
  readonly fleet: FleetState;
  readonly highlight?: MachineId | null | undefined;
  readonly onOpen?: ((id: MachineId) => void) | undefined;
}): JSX.Element {
  const online = fleet.machines.filter((each) => !isAway(each));
  const room = online.reduce((sum, each) => sum + computeHeadroom(each).room, 0);
  return (
    <section className="fx-panel" id="fx-capacity">
      <PanelHead
        title="Capacity"
        lead={
          <>
            Room for <b>{room}</b> more sessions right now. A thread resumes where it started, so a
            full machine makes its threads wait even when others are free.
          </>
        }
      />
      <div className="fx-cap-legend">
        <span>
          <i className="fx-key is-run" /> Running
        </span>
        <span>
          <i className="fx-key" /> Free
        </span>
        <span>
          <i className="fx-key is-wait" /> Waiting
        </span>
      </div>
      <div className="fx-rows">
        <div className="fx-cap-row fx-heads">
          <span />
          <span>Sessions against the cap</span>
          <span />
          <span>Last 24 hours</span>
          <span>Memory</span>
          <span />
        </div>
        {fleet.machines.map((machine) => {
          const away = isAway(machine);
          const headroom = computeHeadroom(machine);
          const pending = fleet.pending.has(`slots:${machine.id}`);
          const suggested = suggestSlots(machine);
          return (
            <div
              key={machine.id}
              className={`fx-cap-row${away ? " is-away" : ""}${highlight === machine.id ? " is-flash" : ""}`}
              data-machine={machine.id}
            >
              <MachineLabel
                machine={machine}
                onOpen={onOpen === undefined ? undefined : () => onOpen(machine.id)}
              />
              <Ladder machine={machine} />
              <span className={machine.queued > 0 ? "fx-num is-you" : "fx-num"}>
                {away ? "—" : `${machine.running} of ${machine.slots}`}
              </span>
              <DayStrip machine={machine} />
              <span className="fx-mem">
                {away ? (
                  <span className="faint">—</span>
                ) : (
                  <>
                    <Meter value={memoryShare(machine)} level={memoryLevel(machine)} width={48} />
                    <span className="fx-num">{Math.round(memoryShare(machine) * 100)}%</span>
                  </>
                )}
              </span>
              <span className="fx-act">
                {away ? (
                  <span className="fx-why is-fail">
                    Away since {machine.lastSeen.split(" ")[0]}
                  </span>
                ) : machine.queued > 0 ? (
                  <>
                    <span className="fx-why is-you">{machine.queued} waiting</span>
                    <button
                      type="button"
                      className="btn btn--sm"
                      aria-disabled={pending || undefined}
                      onClick={() => void setSlots(machine.id, suggested)}
                    >
                      {pending ? (
                        <>
                          <span className="spin" /> Saving…
                        </>
                      ) : (
                        `Allow ${suggested}`
                      )}
                    </button>
                  </>
                ) : (
                  <span className="fx-why">
                    {headroom.room === 0 ? "No room" : `${headroom.room} free`}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Storage across the fleet: real-size bars, each disk's trend, and automatic cleanup. */
export function StoragePanel({
  fleet,
  highlight,
  onCleanup,
  onOpen,
}: {
  readonly fleet: FleetState;
  readonly highlight?: MachineId | null | undefined;
  readonly onCleanup: (id: MachineId) => void;
  readonly onOpen?: ((id: MachineId) => void) | undefined;
}): JSX.Element {
  const scale = Math.max(...fleet.machines.map((each) => each.diskTotalGB));
  const idle = fleet.machines.reduce(
    (sum, each) => sum + buildDiskParts(each, fleet.workspaces).idle,
    0,
  );
  return (
    <section className="fx-panel" id="fx-storage">
      <PanelHead
        title="Storage"
        lead={
          <>
            <b>{formatGB(idle)}</b> sits in workspaces nobody has used for two weeks. Bars are drawn
            to each disk's real size; the trend is the last 14 days, and its dashed end is where it
            is heading.
          </>
        }
      />
      <div className="fx-storage-legend">
        <span>
          <Swatch part="inUse" /> In use
        </span>
        <span>
          <Swatch part="idle" /> Idle workspaces
        </span>
        <span>
          <Swatch part="caches" /> Repository caches
        </span>
        <span>
          <Swatch part="providerData" /> Session data
        </span>
        <span>
          <Swatch part="other" /> Not Hercule's
        </span>
        <span>
          <i className="fx-limit-key" /> Disk limit
        </span>
      </div>
      <div className="fx-rows">
        {fleet.machines.map((machine) => {
          const away = isAway(machine);
          const parts = buildDiskParts(machine, fleet.workspaces);
          const days = daysUntilFull(machine);
          const level = away ? "ok" : diskLevel(machine);
          const history = readHistory(machine);
          const used = history.diskFree.map((free) => machine.diskTotalGB - free);
          return (
            <div
              key={machine.id}
              className={`fx-disk-row${away ? " is-away" : ""}${highlight === machine.id ? " is-flash" : ""}`}
              data-machine={machine.id}
            >
              <MachineLabel
                machine={machine}
                onOpen={onOpen === undefined ? undefined : () => onOpen(machine.id)}
              />
              <span
                className="fx-disk-bar"
                style={{ "--fx-ratio": machine.diskTotalGB / scale } as CSSProperties}
              >
                <span className="fx-disk-fit">
                  <DiskBar machine={machine} parts={parts} height={14} />
                </span>
                <span className="fx-disk-size">{formatGB(machine.diskTotalGB)}</span>
              </span>
              <span className="fx-disk-num">
                <b className={level === "ok" ? undefined : "is-you"}>
                  {Math.round(diskShare(machine) * 100)}%
                </b>
                <span>{formatGB(machine.diskFreeGB)} free</span>
              </span>
              <span className="fx-trend">
                <Sparkline
                  values={used}
                  max={machine.diskTotalGB - machine.diskWatermarkGB}
                  min={zoomFloor(used, machine.diskTotalGB - machine.diskWatermarkGB)}
                  ceiling={machine.diskTotalGB - machine.diskWatermarkGB}
                  forecast={days === null || away ? 0 : Math.min(days, 14)}
                  tone={level === "ok" ? "ink" : "you"}
                  height={24}
                />
                <span className={days === null || away ? "fx-why" : "fx-why is-you"}>
                  {away
                    ? `As of ${machine.lastSeen}`
                    : days === null
                      ? machine.diskTrendGBPerDay <= -1
                        ? `Grows ${Math.round(-machine.diskTrendGBPerDay)} GB a day`
                        : "Steady"
                      : `Limit in ${days} days`}
                </span>
              </span>
              <span className="fx-act">
                {!away && parts.idle >= 3 && (
                  <button
                    type="button"
                    className={level === "ok" ? "btn btn--sm btn--quiet" : "btn btn--sm"}
                    onClick={() => onCleanup(machine.id)}
                  >
                    Clean up {formatGB(parts.idle)}…
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <AutoCleanRow fleet={fleet} />
    </section>
  );
}

/**
 * NEW, and it contradicts ADR 0039, which keeps a Thread's workspace until
 * the user removes it: a fleet-wide rule that removes clean workspaces idle
 * for 30 or 60 days, every night.
 */
export function AutoCleanRow({ fleet }: { readonly fleet: FleetState }): JSX.Element {
  const options: ReadonlyArray<{ readonly value: AutoClean; readonly label: string }> = [
    { value: "off", label: "Off" },
    { value: 60, label: "60 days" },
    { value: 30, label: "30 days" },
  ];
  const preview =
    fleet.autoClean === "off"
      ? autoCleanTargets(fleet, 30)
      : autoCleanTargets(fleet, fleet.autoClean);
  const previewGB = preview.reduce((sum, each) => sum + each.sizeGB, 0);
  return (
    <div className="fx-auto">
      <div className="fx-auto-text">
        <b>Clean up by itself</b>
        <span>
          Every night, removes workspaces idle that long, and only those with no uncommitted
          changes.{" "}
          {fleet.autoClean === "off"
            ? `At 30 days it would remove ${preview.length} today, ${formatGB(previewGB)}.`
            : `Tonight it removes ${preview.length}, ${formatGB(previewGB)}.`}
        </span>
      </div>
      <span className="seg" role="radiogroup" aria-label="Clean up by itself">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={fleet.autoClean === option.value}
            onClick={() => setAutoClean(option.value)}
          >
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}

const POLICY_LABELS: Readonly<Record<Policy, string>> = {
  newest: "Newest",
  pinned: "Pinned",
  "hands-off": "Hands off",
};

/**
 * Software across the fleet: the baseline. Every tool has a policy, every
 * machine a version, and one review updates what is older. A tool's
 * name opens its details: what's new, where it comes from, who needs it.
 */
export function SoftwarePanel({
  fleet,
  highlight,
  onReview,
  onOpenTool,
  onOpenMachine,
}: {
  readonly fleet: FleetState;
  readonly highlight?: MachineId | null | undefined;
  readonly onReview: (machineId?: MachineId) => void;
  readonly onOpenTool?: ((toolId: string) => void) | undefined;
  /** When given, each machine's name over its column opens the machine. */
  readonly onOpenMachine?: ((machineId: MachineId) => void) | undefined;
}): JSX.Element {
  const changes = buildChanges(fleet);
  const pending = changes.some((change) =>
    fleet.pending.has(toolKey(change.tool.id, change.machine.id)),
  );
  const machinesAffected = new Set(changes.map((change) => change.machine.id)).size;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="fx-panel" id="fx-software">
      <PanelHead
        title="Software"
        lead={
          <>
            Each tool's version on every machine, against its newest: for a harness, the newest this
            Hercule release supports; for a toolchain, the newest found on any of your machines.
            Hercule installs its own copies, for its sessions only, next to the machine's.
          </>
        }
      />
      <div className={changes.length > 0 ? "fx-baseline is-due" : "fx-baseline"}>
        {changes.length > 0 ? (
          <>
            <span>
              <b>
                {changes.length} {changes.length === 1 ? "update" : "updates"}
              </b>{" "}
              on {machinesAffected} {machinesAffected === 1 ? "machine" : "machines"}: installed
              tools older than their newest version.
            </span>
            <button
              type="button"
              className="btn btn--sm btn--accent"
              aria-disabled={pending || undefined}
              onClick={() => onReview()}
            >
              {pending ? (
                <>
                  <span className="spin" /> Updating…
                </>
              ) : (
                "Review and update…"
              )}
            </button>
          </>
        ) : (
          <span>
            <CheckIcon size={14} /> Every online machine has the newest versions.
          </span>
        )}
      </div>
      <div
        className="fx-matrix"
        role="table"
        style={{ "--fx-cols": fleet.machines.length } as CSSProperties}
      >
        <div className="fx-mx-head" role="row">
          <span>Tool</span>
          <span>Newest</span>
          {fleet.machines.map((machine) =>
            onOpenMachine === undefined ? (
              <span
                key={machine.id}
                className={`fx-mx-machine${isAway(machine) ? " is-away" : ""}${highlight === machine.id ? " is-flash" : ""}`}
              >
                {machine.name}
              </span>
            ) : (
              <button
                key={machine.id}
                type="button"
                className={`fx-mx-machine is-link${isAway(machine) ? " is-away" : ""}`}
                onClick={() => onOpenMachine(machine.id)}
              >
                {machine.name}
              </button>
            ),
          )}
        </div>
        <MatrixGroup title="Harnesses" />
        {TOOLS.filter((tool) => tool.kind !== "toolchain").map((tool) => (
          <MatrixRow
            key={tool.id}
            fleet={fleet}
            tool={tool}
            isOpen={open === tool.id}
            onToggle={() =>
              onOpenTool === undefined
                ? setOpen(open === tool.id ? null : tool.id)
                : onOpenTool(tool.id)
            }
          />
        ))}
        <MatrixGroup title="Toolchains" />
        {TOOLS.filter((tool) => tool.kind === "toolchain").map((tool) => (
          <MatrixRow
            key={tool.id}
            fleet={fleet}
            tool={tool}
            isOpen={open === tool.id}
            onToggle={() =>
              onOpenTool === undefined
                ? setOpen(open === tool.id ? null : tool.id)
                : onOpenTool(tool.id)
            }
          />
        ))}
      </div>
      <p className="fx-mx-key">
        <span>
          <CheckIcon size={12} /> Has the newest version
        </span>
        <span>
          <b className="is-older">2.6.9</b> Older: an update is waiting
        </span>
        <span>
          <b>—</b> Not installed. Point at it to install
        </span>
      </p>
    </section>
  );
}

export function MatrixGroup({ title }: { readonly title: string }): JSX.Element {
  return (
    <div className="fx-mx-group" role="row">
      <span>{title}</span>
    </div>
  );
}

function MatrixRow({
  fleet,
  tool,
  isOpen,
  onToggle,
}: {
  readonly fleet: FleetState;
  readonly tool: Tool;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const policy = fleet.policies[tool.id]!;
  return (
    <>
      <div className={isOpen ? "fx-mx-row is-open" : "fx-mx-row"} role="row">
        <button
          type="button"
          className="fx-mx-name is-link"
          data-needs={readsNeeds(tool)}
          onClick={onToggle}
          aria-expanded={isOpen}
        >
          <ChevronRightIcon size={12} />
          <ToolMark tool={tool} size={13} />
          <b>{tool.name}</b>
        </button>
        <span className="fx-newest" title={describeNewest(tool)}>
          {findNewest(fleet, tool)}
        </span>
        {fleet.machines.map((machine) => (
          <VersionCell
            key={machine.id}
            fleet={fleet}
            tool={tool}
            machine={machine}
            policy={policy}
          />
        ))}
      </div>
      {isOpen && <ToolDetail fleet={fleet} tool={tool} />}
    </>
  );
}

/** Returns where a tool's newest version comes from, in words. */
export const describeNewest = (tool: Tool): string =>
  tool.kind === "toolchain"
    ? "The newest version found on any of your online machines."
    : "The newest version this Hercule release supports. A Hercule update moves it on.";

/**
 * Returns who decides the version Hercule keeps `tool` at, in words: the
 * Hercule release for a harness on Newest, the newest release for a
 * toolchain on Newest, the user for a pin.
 */
export const describeKeeper = (tool: Tool, policy: Policy): string =>
  policy === "hands-off"
    ? "Hands off: Hercule reports the version it finds, and never installs or updates it."
    : policy === "pinned"
      ? `Pinned by you to ${tool.target}. Every machine gets exactly this version until you move the pin.`
      : tool.kind === "toolchain"
        ? `Newest: ${tool.target} is the newest release Hercule has seen. It checks once a day, and keeps every machine on it.`
        : `Newest: ${tool.target} is the newest version this Hercule release supports. A Hercule update moves it on.`;

/** The policy of a tool, as quiet text that opens its three choices. */
export function PolicyPicker({
  tool,
  policy,
}: {
  readonly tool: Tool;
  readonly policy: Policy;
}): JSX.Element {
  return (
    <span className="fx-policy" title={describeKeeper(tool, policy)}>
      <select
        value={policy}
        aria-label={`The version Hercule keeps ${tool.name} at`}
        onChange={(event) => setPolicy(tool.id, event.target.value as Policy)}
      >
        <option value="newest">
          {tool.kind === "toolchain" ? "Newest release" : "Newest supported"} · {tool.target}
        </option>
        <option value="pinned">Pin to {tool.target}</option>
        <option value="hands-off">Hands off</option>
      </select>
      <span className={`fx-policy-text is-${policy}`}>
        {policy === "hands-off" ? POLICY_LABELS[policy] : tool.target}
        {policy === "newest" && <small> newest</small>}
        {policy === "pinned" && <small> pinned</small>}
      </span>
    </span>
  );
}

export function VersionCell({
  fleet,
  tool,
  machine,
  policy,
}: {
  readonly fleet: FleetState;
  readonly tool: Tool;
  readonly machine: Machine;
  readonly policy: Policy;
}): JSX.Element {
  const status = readToolStatus(fleet, tool, machine);
  const pending = fleet.pending.has(toolKey(tool.id, machine.id));
  if (pending) {
    return (
      <span className="fx-cell is-pending">
        <span className="spin" />
      </span>
    );
  }
  if (status.kind === "unknown") {
    return (
      <span className="fx-cell is-unknown" title={`${machine.name} is away; last known`}>
        {status.installed?.version ?? "—"}
      </span>
    );
  }
  if (status.kind === "missing") {
    // Installing is the user's choice: the cell offers it on hover.
    return policy === "hands-off" || !canInstall(tool, machine) ? (
      <span className="fx-cell is-none" title="Not installed">
        —
      </span>
    ) : (
      <button
        type="button"
        className="fx-cell is-none is-fix"
        title={`Install ${tool.name} ${tool.target} on ${machine.name}`}
        onClick={() => void installTool(tool.id, [machine.id])}
      >
        <span className="fx-cell-text">—</span>
        <span className="fx-cell-hover">Install</span>
      </button>
    );
  }
  const { installed } = status;
  if (policy === "hands-off") {
    return <span className="fx-cell is-current">{installed.version}</span>;
  }
  if (status.kind === "older") {
    return (
      <button
        type="button"
        className="fx-cell is-older is-fix"
        title={`${installed.source === "machine" ? "The machine's own copy" : "Installed by Hercule"}. The newest is ${findNewest(fleet, tool)}.`}
        onClick={() => void installTool(tool.id, [machine.id])}
      >
        <span className="fx-cell-text">{installed.version}</span>
        <span className="fx-cell-hover">Update</span>
      </button>
    );
  }
  return (
    <span
      className="fx-cell is-current"
      title={`${installed.version}, ${installed.source === "machine" ? "the machine's own" : "installed by Hercule"}`}
    >
      <CheckIcon size={13} />
    </span>
  );
}

/** A tool's details, opened under its row: who sets its version, what's new, where it is. */
export function ToolDetail({
  fleet,
  tool,
}: {
  readonly fleet: FleetState;
  readonly tool: Tool;
}): JSX.Element {
  const news = TOOL_NEWS[tool.id];
  const policy = fleet.policies[tool.id]!;
  const online = fleet.machines.filter((machine) => !isAway(machine));
  const behind = online.filter((machine) => readToolStatus(fleet, tool, machine).kind === "older");
  const without = online.filter(
    (machine) =>
      readToolStatus(fleet, tool, machine).kind === "missing" && canInstall(tool, machine),
  );
  return (
    <div className="fx-tool-detail">
      <div>
        <p className="fx-tool-blurb">{tool.blurb}</p>
        <p className="fx-tool-keeper">
          Newest: {findNewest(fleet, tool)}. {describeNewest(tool)}
        </p>
        {news !== undefined && (
          <>
            <h4>
              What's new in {tool.target} <small>{news.released}</small>
            </h4>
            <ul>
              {news.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            {news.vendorLatest !== tool.target && (
              <p className="fx-tool-note">
                The vendor has released {news.vendorLatest}. This Hercule supports up to{" "}
                {tool.target}.
              </p>
            )}
          </>
        )}
      </div>
      <div className="fx-tool-side">
        <span className="faint">
          Installs with{" "}
          {tool.via.macos === null
            ? "nothing: install it by hand"
            : tool.via.macos === tool.via.linux
              ? tool.via.macos
              : `${tool.via.macos} on macOS, ${tool.via.linux} on Linux`}
        </span>
        {news !== undefined && (
          <a className="link" href="#notes">
            Full release notes <ExternalIcon size={12} />
          </a>
        )}
        {policy !== "hands-off" && behind.length > 0 && (
          <ToolButton
            tool={tool}
            machines={behind}
            label={`Update ${behind.length === 1 ? behind[0]!.name : `${behind.length} machines`}`}
          />
        )}
        {policy !== "hands-off" && without.length > 0 && (
          <ToolButton
            tool={tool}
            machines={without}
            label={`Install on ${without.length === 1 ? without[0]!.name : `${without.length} more machines`}`}
            quiet
          />
        )}
      </div>
    </div>
  );
}

// ---------- The review ----------

/**
 * Renders the review of every update the machines need, or
 * one machine's changes when `machineId` is given. Each machine's changes
 * can be left out. Applying shows each change finish in place.
 */
export function ReviewDialog({
  machineId,
  onClose,
}: {
  readonly machineId?: MachineId | undefined;
  readonly onClose: () => void;
}): JSX.Element {
  const fleet = useFleet();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [changes] = useState<ReadonlyArray<Change>>(() =>
    buildChanges(fleet).filter(
      (change) => machineId === undefined || change.machine.id === machineId,
    ),
  );
  const [left, setLeft] = useState<ReadonlySet<MachineId>>(() => new Set());
  const [applying, setApplying] = useState(false);
  const chosen = changes.filter((change) => !left.has(change.machine.id));
  const byMachine = fleet.machines
    .map((machine) => ({
      machine,
      list: changes.filter((change) => change.machine.id === machine.id),
    }))
    .filter((group) => group.list.length > 0);
  const done = (change: Change) =>
    applying && !fleet.pending.has(toolKey(change.tool.id, change.machine.id));
  const allDone = applying && chosen.every(done);

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="fx-review"
      label="Update the machines"
      onClose={onClose}
    >
      <div className="pop-h fx-review-h">
        <b>{machineId === undefined ? "Update every machine" : `Update ${machineId}`}</b>
        <span>
          {chosen.length} {chosen.length === 1 ? "update" : "updates"} on{" "}
          {byMachine.length - left.size}{" "}
          {byMachine.length - left.size === 1 ? "machine" : "machines"}
        </span>
      </div>
      <div className="fx-review-body">
        {byMachine.map(({ machine, list }) => {
          const included = !left.has(machine.id);
          return (
            <section key={machine.id} className={included ? "fx-rv" : "fx-rv is-left"}>
              <label className="fx-rv-h">
                <span className="choice-box">
                  <input
                    type="checkbox"
                    checked={included}
                    disabled={applying}
                    onChange={(event) => {
                      const next = new Set(left);
                      if (event.target.checked) next.delete(machine.id);
                      else next.add(machine.id);
                      setLeft(next);
                    }}
                  />
                  <CheckIcon size={12} />
                </span>
                <MachineIcon machine={machine} size={14} />
                <b>{machine.name}</b>
                <span>
                  {list.length} {list.length === 1 ? "change" : "changes"}
                  {machine.running > 0 && ` · ${machine.running} sessions running`}
                </span>
              </label>
              {list.map((change) => (
                <div key={change.tool.id} className="fx-rv-row">
                  <span className="fx-rv-state">
                    {applying && included ? (
                      done(change) ? (
                        <CheckIcon size={13} />
                      ) : (
                        <span className="spin" />
                      )
                    ) : null}
                  </span>
                  <span className="fx-rv-mark">
                    <ToolMark tool={change.tool} size={13} />
                  </span>
                  <b>{change.tool.name}</b>
                  <span className="fx-rv-ver">
                    {change.from === null ? (
                      <span className="faint">not installed</span>
                    ) : (
                      <span className="faint">{change.from}</span>
                    )}
                    <span className="fx-rv-arrow">→</span>
                    {change.tool.target}
                  </span>
                  <span className="fx-rv-why">
                    {change.kind === "alongside" ? "Next to the machine's own copy · " : ""}
                    {change.why}
                  </span>
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <div className="fx-review-foot">
        <span className="faint">
          Running sessions keep what they started with. A runner update waits for its sessions to
          finish.
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn--quiet" onClick={() => dialogRef.current?.close()}>
          {allDone ? "Close" : "Cancel"}
        </button>
        <button
          type="button"
          className="btn btn--accent"
          data-unready={chosen.length === 0 || undefined}
          aria-disabled={applying || undefined}
          onClick={async () => {
            if (applying || chosen.length === 0) return;
            setApplying(true);
            await applyChanges(chosen);
            setTimeout(() => dialogRef.current?.close(), 700);
          }}
        >
          {allDone ? (
            "Done"
          ) : applying ? (
            <>
              <span className="spin" /> Applying…
            </>
          ) : (
            `Update ${chosen.length}`
          )}
        </button>
      </div>
    </GlassDialog>
  );
}

// ---------- A machine's page ----------

/**
 * B's machine page, grown up: the room left in one sentence, instruments
 * with their trends, who is working here, storage with its forecast, the
 * machine's slice of the baseline, and what happened lately. Sections carry
 * ids, so a variant can scroll to the concern the user came for.
 */
export function MachinePage({
  fleet,
  machine,
  onCleanup,
  onReview,
  onShowActivity,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly onCleanup: () => void;
  readonly onReview: () => void;
  /** When given, the Recent section ends in a way into the machine's whole activity. */
  readonly onShowActivity?: (() => void) | undefined;
}): JSX.Element {
  const away = isAway(machine);
  const parts = buildDiskParts(machine, fleet.workspaces);
  const days = daysUntilFull(machine);
  const disk = away ? "ok" : diskLevel(machine);
  const headroom = computeHeadroom(machine);
  const history = readHistory(machine);
  const idle = idleWorkspaces(machine.id, fleet.workspaces).toSorted((a, b) => b.sizeGB - a.sizeGB);
  const changes = buildChanges(fleet).filter((change) => change.machine.id === machine.id);
  const pendingSlots = fleet.pending.has(`slots:${machine.id}`);
  const used = history.diskFree.map((free) => machine.diskTotalGB - free);

  return (
    <div className="fx-page">
      <header className="fx-hero">
        <span
          className="fx-hero-icon"
          style={{ viewTransitionName: `fx-icon-${machine.id}` } as CSSProperties}
        >
          <MachineIcon machine={machine} size={22} />
        </span>
        <div className="fx-hero-text">
          <h2 style={{ viewTransitionName: `fx-name-${machine.id}` } as CSSProperties}>
            {machine.name}
          </h2>
          <p>
            <StatusDot machine={machine} level={worstLevel(machine)} />
            {away && machine.lostContact
              ? `Unreachable since ${machine.lastSeen}`
              : describeState(machine)}{" "}
            · {machine.model} · {machine.os} · {machine.arch} · runner {machine.runnerVersion}
          </p>
        </div>
        {machine.lifecycle === "draining" ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setDraining(machine.id, false)}
          >
            Take new work again
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm"
            disabled={away}
            onClick={() => setDraining(machine.id, true)}
          >
            Stop new work
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="More">
          <MoreIcon size={16} />
        </button>
      </header>

      {away && (
        <div className="fx-banner is-fail">
          <div>
            <p>
              {machine.lostContact
                ? `It stopped answering on ${machine.lastSeen}, without signing off.`
                : `It signed off on ${machine.lastSeen}.`}
            </p>
            <span>
              It may be asleep, off the network, or without power. {machine.pinned} threads that
              started there wait for it, and resume when it is back. If it does not reconnect by
              itself, run <code>hercule runner start</code> on it. What you see below is from{" "}
              {machine.lastSeen}.
            </span>
          </div>
          <button type="button" className="btn btn--sm btn--danger">
            Retire…
          </button>
        </div>
      )}
      {!away && disk !== "ok" && (
        <div className="fx-banner" data-needs="disk total · history · workspace sizes">
          <div>
            <p>
              The disk is {Math.round(diskShare(machine) * 100)}% full
              {days !== null && `, and stops taking sessions in about ${days} days`}.
            </p>
            <span>
              {formatGB(parts.idle)} of it is in {idle.length} workspaces nobody has used for two
              weeks.
            </span>
          </div>
          <button type="button" className="btn btn--sm" onClick={onCleanup}>
            Clean up…
          </button>
        </div>
      )}
      {!away && machine.queued > 0 && (
        <div className="fx-banner">
          <div>
            <p>
              All {machine.slots} sessions are in use, and {machine.queued} threads are waiting.
            </p>
            <span>
              They resume here, where they started. Memory is at{" "}
              {Math.round(memoryShare(machine) * 100)}%.
            </span>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            aria-disabled={pendingSlots || undefined}
            onClick={() => void setSlots(machine.id, suggestSlots(machine))}
          >
            {pendingSlots ? (
              <>
                <span className="spin" /> Saving…
              </>
            ) : (
              `Allow ${suggestSlots(machine)} sessions`
            )}
          </button>
        </div>
      )}

      <section className="fx-psec" id="fx-m-capacity">
        {!away && (
          <p className="fx-room-line">
            Room for <b>{headroom.room}</b> more {headroom.room === 1 ? "session" : "sessions"}:{" "}
            {describeLimit(machine, headroom)}.
          </p>
        )}
        <div className="fx-instruments">
          <div className={`fx-inst fx-gauge--${machine.queued > 0 ? "warn" : "ok"}`}>
            <span className="fx-gauge-label">Sessions</span>
            <b>{away ? "—" : `${machine.running} of ${machine.slots}`}</b>
            <Ladder machine={machine} />
            <DayStrip machine={machine} tall />
            <span className="fx-inst-note">
              Last 24 hours
              {history.waiting.some((count) => count > 0) ? ", marigold where threads waited" : ""}
            </span>
          </div>
          <div className={`fx-inst fx-gauge--${disk}`} data-needs="disk total">
            <span className="fx-gauge-label">Disk</span>
            <b>{Math.round(diskShare(machine) * 100)}%</b>
            <Meter value={diskShare(machine)} level={disk} height={6} />
            <Sparkline
              values={used}
              max={machine.diskTotalGB - machine.diskWatermarkGB}
              min={zoomFloor(used, machine.diskTotalGB - machine.diskWatermarkGB)}
              ceiling={machine.diskTotalGB - machine.diskWatermarkGB}
              forecast={days === null || away ? 0 : Math.min(days, 14)}
              tone={disk === "ok" ? "ink" : "you"}
              height={40}
            />
            <span className="fx-inst-note">
              {formatGB(machine.diskFreeGB)} free of {formatGB(machine.diskTotalGB)} ·{" "}
              {days !== null && !away ? `limit in ${days} days` : "last 14 days"}
            </span>
          </div>
          <div className={`fx-inst fx-gauge--${memoryLevel(machine)}`}>
            <span className="fx-gauge-label">Memory</span>
            <b>{away ? "—" : `${Math.round(memoryShare(machine) * 100)}%`}</b>
            <Meter
              value={away ? 0 : memoryShare(machine)}
              level={memoryLevel(machine)}
              height={6}
            />
            <Sparkline values={history.memory} max={1} ceiling={0.92} height={40} />
            <span className="fx-inst-note">
              {away ? (
                "Last 24 hours"
              ) : (
                <>
                  {formatGB(machine.memoryFreeGB)} free of {formatGB(machine.memoryTotalGB)} ·{" "}
                  <span data-needs="CPU">CPU {machine.cpu}%</span>
                </>
              )}
            </span>
          </div>
        </div>
      </section>

      <RunningHere fleet={fleet} machine={machine} />

      <section className="fx-psec" id="fx-m-storage">
        <h3>
          Storage{" "}
          <small data-needs="disk total">
            {formatGB(parts.used)} used of {formatGB(machine.diskTotalGB)}
          </small>
        </h3>
        <DiskBar machine={machine} parts={parts} height={14} split />
        <div className="fx-legend" data-needs="workspace sizes">
          <LegendItem part="inUse" label="Workspaces in use" gb={parts.inUse} />
          <LegendItem part="idleClean" label="Idle, no changes" gb={parts.idleClean} />
          <LegendItem part="idleDirty" label="Idle, with changes" gb={parts.idleDirty} />
          <LegendItem part="caches" label="Repository caches" gb={parts.caches} />
          <LegendItem
            part="providerData"
            label="Session data"
            gb={parts.providerData + parts.logs}
          />
          <LegendItem part="other" label="Not Hercule's" gb={parts.other} />
        </div>
        <AutoCleanupLine fleet={fleet} machine={machine} />
        {idle.length > 0 && (
          <div className="fx-idle" data-needs="workspace sizes">
            <div className="fx-idle-h">
              <b>Largest idle workspaces</b>
              {!away && (
                <button type="button" className="link" onClick={onCleanup}>
                  Review all {idle.length}…
                </button>
              )}
            </div>
            {idle.slice(0, 4).map((each) => (
              <div key={each.id} className="fx-idle-row">
                <ProjectDot project={each.project} />
                <span className="fx-idle-name">
                  <b>{each.thread}</b>
                  <span>
                    {each.project} · {each.branch}
                  </span>
                </span>
                {each.changes > 0 && (
                  <span className="chip chip--you" data-needs="workspace changes">
                    {each.changes} {each.changes === 1 ? "file" : "files"} changed
                  </span>
                )}
                <span className="fx-idle-age">{formatDays(each.lastUsedDays)}</span>
                <span
                  className="fx-idle-gb"
                  title={`${formatGB(each.sizeGB)} on disk; removing it frees ${formatGB(each.freesGB)}`}
                >
                  {formatGB(each.freesGB)}
                  {each.freesGB < each.sizeGB * 0.9 && <small>of {formatGB(each.sizeGB)}</small>}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="fx-psec" id="fx-m-software">
        <h3>
          Software
          <small>
            {changes.length === 0
              ? "Every tool has its newest version"
              : `${changes.length} ${changes.length === 1 ? "update" : "updates"} waiting`}
          </small>
        </h3>
        {changes.length > 0 && (
          <div className="fx-baseline is-due">
            <span>
              {changes.map((change) => change.tool.name).join(", ")}{" "}
              {changes.length === 1 ? "is" : "are"} older than the newest.
            </span>
            <button type="button" className="btn btn--sm btn--accent" onClick={onReview}>
              Review and update…
            </button>
          </div>
        )}
        <ProviderRows fleet={fleet} machine={machine} />
        <h4 className="fx-sw-h">Tools</h4>
        <div className="fx-sw">
          {TOOLS.filter((tool) => tool.kind !== "harness").map((tool) => {
            const status = readToolStatus(fleet, tool, machine);
            const policy = fleet.policies[tool.id]!;
            const change = changes.find((each) => each.tool === tool);
            return (
              <div
                key={tool.id}
                className={change === undefined ? "fx-sw-row" : "fx-sw-row is-due"}
              >
                <span className="fx-sw-name" data-needs={readsNeeds(tool)}>
                  <ToolMark tool={tool} size={13} />
                  {tool.name}
                </span>
                <span className="fx-sw-ver">
                  {status.kind === "missing" ? (
                    <span className="faint">Not installed</span>
                  ) : status.kind === "unknown" ? (
                    <span className="faint">{status.installed?.version ?? "—"}</span>
                  ) : (
                    <span className={change !== undefined ? "fp-ver is-older" : "fp-ver"}>
                      {status.installed.version}
                    </span>
                  )}
                </span>
                <span className="fx-sw-src">
                  {change !== undefined
                    ? `${change.kind === "alongside" ? "The machine's own copy. " : ""}The newest is ${findNewest(fleet, tool)}`
                    : status.kind === "current" || status.kind === "older"
                      ? status.installed.source === "hercule"
                        ? "Installed by Hercule"
                        : "The machine's own"
                      : ""}
                </span>
                <span className="fx-sw-policy" title={describeNewest(tool)}>
                  {findNewest(fleet, tool)} newest
                </span>
                <span className="fx-sw-act">
                  {!away && policy !== "hands-off" && status.kind === "missing" && (
                    <ToolButton tool={tool} machines={[machine]} label="Install" quiet />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="fx-psec" id="fx-m-activity">
        <h3>
          Recent
          <small>From the controller's audit log</small>
        </h3>
        <ol className="fx-acts">
          {fleet.activity[machine.id].slice(0, 5).map((entry) => (
            <ActivityRow key={entry.id} entry={entry} withDay />
          ))}
        </ol>
        {onShowActivity !== undefined && (
          <button
            type="button"
            className="fx-more"
            onClick={onShowActivity}
            data-needs="API: filter the log by machine"
          >
            All activity <span>{fleet.activity[machine.id].length} in the last 10 days</span>
            <ChevronRightIcon size={12} />
          </button>
        )}
      </section>

      <section className="fx-psec" id="fx-m-settings">
        <h3>Settings</h3>
        <div className="set-row">
          <div className="set-label">
            <b>Session cap</b>
            <span>How many sessions run here at once.</span>
          </div>
          <span className="fx-stepper">
            <button
              type="button"
              aria-label="Fewer"
              onClick={() => void setSlots(machine.id, Math.max(1, machine.slots - 1))}
            >
              −
            </button>
            <b>{machine.slots}</b>
            <button
              type="button"
              aria-label="More"
              onClick={() => void setSlots(machine.id, machine.slots + 1)}
            >
              +
            </button>
          </span>
        </div>
        <div className="set-row">
          <div className="set-label">
            <b>Labels</b>
            <span>Work can ask for a machine by its labels.</span>
          </div>
          <span className="fx-labels">
            {machine.labels.map((label) => (
              <span key={label} className="chip">
                {label}
              </span>
            ))}
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Add a label">
              <PlusIcon size={12} />
            </button>
          </span>
        </div>
        <div className="set-row">
          <div className="set-label">
            <b>Reserved</b>
            <span>Runs only the work that names this machine.</span>
          </div>
          <button type="button" className="toggle" role="switch" aria-checked={machine.reserved} />
        </div>
        <div className="set-row">
          <div className="set-label">
            <b>Disk limit</b>
            <span>Below this much free space, it takes no new sessions.</span>
          </div>
          <span className="fx-value">{machine.diskWatermarkGB} GB</span>
        </div>
        <div className="set-row">
          <div className="set-label">
            <b>Retire this machine</b>
            <span>Forgets it. Its threads keep their transcripts, but cannot resume.</span>
          </div>
          <button type="button" className="btn btn--danger">
            Retire…
          </button>
        </div>
      </section>
    </div>
  );
}

function LegendItem({
  part,
  label,
  gb,
}: {
  readonly part: string;
  readonly label: string;
  readonly gb: number;
}): JSX.Element {
  return (
    <span className="fx-legend-item">
      <Swatch part={part} />
      <span>{label}</span>
      <b>{formatGB(gb)}</b>
    </span>
  );
}

/** Flashes the row of `machineId` in the panel `concern`, after scrolling it into view. */
export const flashRow = (
  root: HTMLElement | null,
  concern: Concern,
  machineId: MachineId,
): void => {
  const panel = root?.querySelector<HTMLElement>(`#fx-${concern}`);
  if (panel === null || panel === undefined) return;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  const row = panel.querySelector<HTMLElement>(`[data-machine="${machineId}"]`);
  if (row === null) return;
  row.classList.remove("is-flash");
  // Restarts the animation when the same row flashes twice.
  void row.offsetWidth;
  row.classList.add("is-flash");
};

/**
 * Runs `update` inside a view transition, so what moves glides from where it
 * was, then `after`, once the new layout is in the document. Falls back to a
 * plain update when the browser has none or Reduce motion is on.
 */
export const transition = (update: () => void, after?: () => void): void => {
  const run = () => {
    flushSync(update);
    after?.();
  };
  if (
    typeof document.startViewTransition !== "function" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    run();
    return;
  }
  document.startViewTransition(run);
};

/**
 * Returns which of the elements with `ids` is the last one whose top has
 * scrolled past the header, in the scroll area `ref`.
 */
export const useScrollSpy = <Id extends string>(
  ref: RefObject<HTMLElement | null>,
  ids: ReadonlyArray<Id>,
  resetKey: string,
  reach = 140,
): Id => {
  const [current, setCurrent] = useState<Id>(ids[0]!);
  useEffect(() => {
    const area = ref.current;
    if (area === null) return;
    const onScroll = () => {
      const top = area.getBoundingClientRect().top;
      let found = ids[0]!;
      for (const id of ids) {
        const element = area.querySelector<HTMLElement>(`#${id}`);
        if (element !== null && element.getBoundingClientRect().top - top <= reach) found = id;
      }
      if (area.scrollTop + area.clientHeight >= area.scrollHeight - 4) found = ids.at(-1)!;
      setCurrent(found);
    };
    onScroll();
    area.addEventListener("scroll", onScroll, { passive: true });
    return () => area.removeEventListener("scroll", onScroll);
    // `ids` is a new array each render; `resetKey` names what it holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, resetKey]);
  return current;
};

/** Scrolls the area `ref` so the element `id` sits under the header. */
export const scrollToId = (ref: RefObject<HTMLElement | null>, id: string, smooth = true): void => {
  const element = ref.current?.querySelector<HTMLElement>(`#${id}`);
  element?.scrollIntoView({ behavior: smooth ? "smooth" : "instant", block: "start" });
};

// ---------- What runs on a machine ----------

const SESSION_POSE = { working: "working", waiting: "waiting", queued: "idle" } as const;

/** A session's face: its kind's look, in the pose of its state. */
export function SessionFace({
  session,
  size,
}: {
  readonly session: WorkSession;
  readonly size: number;
}): JSX.Element {
  const look =
    session.kind === "assistant"
      ? buildAssistantLook(session.id)
      : buildSessionLook(session.id, session.kind === "thread" ? "thread" : session.kind);
  return <Face look={look} pose={SESSION_POSE[session.state]} size={size} />;
}

const WORK_KIND_LABEL: Readonly<Record<Workload["kind"], string>> = {
  run: "Workflow run",
  threads: "Threads",
  assistant: "Assistant",
};

/** The first rows a long list of work shows before "Show all". */
const SHOWN_WORK = 8;

/**
 * Renders what runs on `machine`, by workload: a workflow's run, the threads
 * of one sidebar row, or an assistant's conversation, each with the faces of
 * its sessions, so the sessions still add up to what counts against the cap.
 * The switch turns it into the plain list of sessions. Work that waits for a
 * slot comes last, under its own heading.
 */
export function RunningHere({
  fleet,
  machine,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
}): JSX.Element | null {
  const [view, setView] = useState<"work" | "sessions">("work");
  const [all, setAll] = useState(false);
  const work = fleet.workloads.filter((each) => each.machineId === machine.id);
  if (work.length === 0) return null;
  const isWaiting = (workload: Workload) =>
    workload.sessions.every((each) => each.state === "queued");
  const asksYou = (workload: Workload) =>
    workload.sessions.some((each) => each.state === "waiting");
  const active = work
    .filter((each) => !isWaiting(each))
    .toSorted((a, b) => Number(asksYou(b)) - Number(asksYou(a)));
  const waiting = work.filter(isWaiting);
  const sessions = active.flatMap((workload) =>
    workload.sessions.map((session) => ({ session, workload })),
  );
  const shown = all ? active : active.slice(0, SHOWN_WORK);
  return (
    <section className="fx-psec" id="fx-m-work">
      <div className="fx-work-h">
        <h3>Running here</h3>
        <span className="fx-work-sum">
          {active.length} {active.length === 1 ? "workload" : "workloads"}, {sessions.length} of{" "}
          {machine.slots} sessions
        </span>
        <span className="seg fx-work-view" role="group" aria-label="Show">
          <button type="button" aria-pressed={view === "work"} onClick={() => setView("work")}>
            Work
          </button>
          <button
            type="button"
            aria-pressed={view === "sessions"}
            onClick={() => setView("sessions")}
          >
            Sessions
          </button>
        </span>
      </div>
      {view === "work" ? (
        <div className="fx-work">
          {shown.map((workload) => (
            <WorkRow key={workload.id} workload={workload} />
          ))}
          {active.length > SHOWN_WORK && (
            <button type="button" className="fx-more" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${active.length}`}
            </button>
          )}
          {waiting.length > 0 && (
            <>
              <h4 className="fx-work-sub">
                Waiting for a slot <span className="count count--you">{waiting.length}</span>
                <small>They resume here, where they started.</small>
              </h4>
              {waiting.map((workload) => (
                <WorkRow key={workload.id} workload={workload} />
              ))}
            </>
          )}
        </div>
      ) : (
        <>
          <ul className="fx-sessions">
            {[...active, ...waiting]
              .flatMap((workload) => workload.sessions.map((session) => ({ session, workload })))
              .slice(0, all ? undefined : 24)
              .map(({ session, workload }) => (
                <li key={session.id} className={`is-${session.state}`}>
                  <SessionFace session={session} size={24} />
                  <span className="fx-sessions-name">
                    <b>{session.label === "lead" ? workload.title : session.label}</b>
                    <span>
                      {session.label === "lead"
                        ? WORK_KIND_LABEL[workload.kind]
                        : `in ${workload.title}`}
                    </span>
                  </span>
                  <span className="fx-sessions-state">
                    {session.state === "working"
                      ? "Working"
                      : session.state === "waiting"
                        ? "Asks you"
                        : "Waits for a slot"}
                  </span>
                </li>
              ))}
          </ul>
          {sessions.length + waiting.length > 24 && (
            <button type="button" className="fx-more" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${sessions.length + waiting.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function WorkRow({ workload }: { readonly workload: Workload }): JSX.Element {
  const lead = workload.sessions[0]!;
  const asking = workload.sessions.filter((each) => each.state === "waiting");
  const queued = workload.sessions.every((each) => each.state === "queued");
  const members = workload.sessions.map((each) => each.label).join(", ");
  return (
    <div className={queued ? "fx-work-row is-queued" : "fx-work-row"}>
      <span className="fx-work-glyph">
        {workload.kind === "run" ? (
          <span className="fx-work-icon">
            <WorkflowsIcon size={15} />
          </span>
        ) : (
          <SessionFace session={lead} size={28} />
        )}
      </span>
      <span className="fx-work-text">
        <b>{workload.title}</b>
        <span>
          {WORK_KIND_LABEL[workload.kind]}
          {workload.project !== null && (
            <>
              {" · "}
              <ProjectDot project={workload.project} /> {workload.project}
            </>
          )}
          {workload.branch !== null && ` · ${workload.branch}`}
          {asking.length > 0 && (
            <em>
              {" · "}
              {asking[0]!.label === "lead" ? "asks you" : `${asking[0]!.label} asks you`}
            </em>
          )}
        </span>
      </span>
      <span className="fx-work-faces" title={members}>
        {workload.sessions.map((session) => (
          <SessionFace key={session.id} session={session} size={18} />
        ))}
      </span>
      <span className="fx-work-count">
        {workload.sessions.length} {workload.sessions.length === 1 ? "session" : "sessions"}
      </span>
      <span className="fx-work-since">{workload.since}</span>
    </div>
  );
}

// ---------- Activity ----------

const ACTIVITY_FILTERS = [
  { key: "all", label: "All" },
  { key: "problems", label: "Problems" },
  { key: "connection", label: "Connection" },
  { key: "sessions", label: "Sessions" },
  { key: "workspaces", label: "Workspaces" },
  { key: "settings", label: "Settings" },
] as const;

type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]["key"];

const keepsEntry = (filter: ActivityFilter, entry: ActivityEntry): boolean =>
  filter === "all" ? true : filter === "problems" ? entry.problem : entry.category === filter;

/**
 * One line of activity: its time, what happened, and who did it. An entry
 * that stands for several log entries opens to list them. The audit kind
 * behind it is in the tooltip.
 */
export function ActivityRow({
  entry,
  withDay = false,
}: {
  readonly entry: ActivityEntry;
  readonly withDay?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const by =
    entry.actor === "you" ? "by you" : entry.actor === "Hercule" ? null : `by ${entry.actor}`;
  const items = entry.items ?? [];
  return (
    <li
      className={`fx-act is-${entry.category}${entry.problem ? " is-problem" : ""}`}
      title={entry.source}
    >
      <time>
        {withDay && entry.day !== "Today" ? `${entry.day}, ` : ""}
        {entry.time}
      </time>
      <i className="fx-act-dot" />
      <span className="fx-act-text">
        <span>
          {entry.text}
          {by !== null && <small> {by}</small>}
          {items.length > 1 && (
            <button
              type="button"
              className="fx-act-more"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
            >
              {open ? "Hide" : `Show ${items.length}`}
            </button>
          )}
          {items.length === 1 && <small> · {items[0]}</small>}
        </span>
        {open && (
          <ul>
            {items.map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
          </ul>
        )}
      </span>
    </li>
  );
}

/**
 * Renders a machine's whole activity, by day, newest first, with filters.
 * It shows only what the controller's audit log records today, which it
 * keeps for 90 days.
 */
export function ActivityView({
  fleet,
  machine,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
}): JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const entries = fleet.activity[machine.id];
  const kept = entries.filter((entry) => keepsEntry(filter, entry));
  const days = [...new Set(kept.map((entry) => entry.day))];
  return (
    <div className="fx-page fx-activity-page">
      <header className="fx-activity-h">
        <h2>Activity</h2>
        <p>
          Everything the controller recorded about {machine.name} in the last 10 days: its
          connection, its settings, the sessions it started and the workspaces it removed. The
          controller keeps 90 days.
        </p>
      </header>
      <div className="fx-filters" role="group" aria-label="Show">
        {ACTIVITY_FILTERS.map(({ key, label }) => {
          const count = entries.filter((entry) => keepsEntry(key, entry)).length;
          return (
            <button
              key={key}
              type="button"
              className={`${filter === key ? "is-on" : ""}${key === "problems" && count > 0 ? " is-problem" : ""}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label} <small>{count}</small>
            </button>
          );
        })}
      </div>
      {days.length === 0 ? (
        <p className="fx-activity-empty">
          {filter === "problems"
            ? `No problems on ${machine.name} in the last 10 days.`
            : "Nothing here in the last 10 days."}
        </p>
      ) : (
        days.map((day) => (
          <section key={day} className="fx-day-group">
            <h4>{day}</h4>
            <ol className="fx-acts">
              {kept
                .filter((entry) => entry.day === day)
                .map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} />
                ))}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}

// ---------- Automatic cleanup, harnesses and accounts ----------

/**
 * Renders the one line that says Hercule cleans up by itself, with what it
 * last removed, and an info button whose popover lists the exact rules.
 */
function AutoCleanupLine({
  fleet,
  machine,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
}): JSX.Element {
  const last = findLastSweep(fleet, machine.id);
  const popoverId = `fx-auto-${machine.id}`;
  return (
    <div className="fx-auto-line">
      <span>Hercule cleans up by itself.</span>
      {last !== null && (
        <span className="faint">
          Last: {last.text.charAt(0).toLowerCase() + last.text.slice(1)},{" "}
          {last.day === "Today" || last.day === "Yesterday" ? last.day.toLowerCase() : last.day}{" "}
          {last.time}.
        </span>
      )}
      <button
        type="button"
        className="icon-btn icon-btn--sm fx-info"
        popoverTarget={popoverId}
        aria-label="When Hercule removes a workspace by itself"
        style={{ anchorName: `--${popoverId}` } as CSSProperties}
      >
        <QuestionIcon size={14} />
      </button>
      <div
        id={popoverId}
        popover="auto"
        className="pop fx-auto-pop"
        style={{ positionAnchor: `--${popoverId}` } as CSSProperties}
      >
        <b>When Hercule removes a workspace by itself</b>
        <ul>
          <li>
            A workflow run's workspace: as soon as the run finishes, or 14 days after it failed.
          </li>
          <li>
            A thread's workspace: once every thread in it is archived, nobody has used it for 7
            days, and it has no uncommitted files.
          </li>
        </ul>
        <span>Everything else stays until you clean it up.</span>
      </div>
    </div>
  );
}

/**
 * Renders the machine's harnesses (installed or not, the version, and its
 * verdict against the version this Hercule pins), then each per-machine
 * Provider Account, signed in here or not. Sign in opens the account's own
 * sign-in dialog for this runner, as Settings › Providers does (ADR 0048).
 * Install and Update are drawn for #974; v1 builds neither.
 */
function ProviderRows({
  fleet,
  machine,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
}): JSX.Element {
  const away = isAway(machine);
  const harnesses = TOOLS.filter((tool) => tool.kind === "harness");
  return (
    <>
      <h4 className="fx-sw-h">Harnesses</h4>
      <div className="fx-sw">
        {harnesses.map((tool) => {
          const status = readToolStatus(fleet, tool, machine);
          return (
            <div key={tool.id} className="fx-sw-row">
              <span className="fx-sw-name">
                <ToolMark tool={tool} size={13} />
                {tool.name}
              </span>
              <span className="fx-sw-ver">
                {status.kind === "missing" ? (
                  <span className="faint">Not installed</span>
                ) : status.kind === "unknown" ? (
                  <span className="faint">{status.installed?.version ?? "—"}</span>
                ) : (
                  <span className={status.kind === "older" ? "fp-ver is-older" : "fp-ver"}>
                    {status.installed.version}
                  </span>
                )}
              </span>
              <span className={status.kind === "older" ? "fx-sw-src is-you" : "fx-sw-src"}>
                {status.kind === "older"
                  ? `Older than ${tool.target}, the version this Hercule supports`
                  : status.kind === "current"
                    ? "The version this Hercule supports"
                    : ""}
              </span>
              <span className="fx-sw-policy">{tool.target} newest</span>
              <span className="fx-sw-act">
                {!away && status.kind === "missing" && (
                  <button type="button" className="btn btn--sm btn--quiet" title="After v1 (#974)">
                    Install
                  </button>
                )}
                {!away && status.kind === "older" && (
                  <button type="button" className="btn btn--sm btn--quiet" title="After v1 (#974)">
                    Update
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <h4 className="fx-sw-h">Accounts signed in here</h4>
      <div className="fx-sw">
        {PROVIDER_ACCOUNTS.filter((account) => account.perMachine).map((account) => {
          const tool = TOOLS.find((each) => each.id === account.harnessId)!;
          const installed = fleet.installed[tool.id]?.[machine.id];
          const signedIn = fleet.logins.has(`${machine.id}:${account.id}`);
          const pending = fleet.pending.has(`login:${machine.id}:${account.id}`);
          return (
            <div key={account.id} className="fx-sw-row fx-account">
              <span className="fx-sw-name">
                <ToolMark tool={tool} size={13} />
                {account.name}
              </span>
              <span className="fx-sw-ver faint">{tool.name}</span>
              <span
                className={
                  signedIn || installed === undefined || away ? "fx-sw-src" : "fx-sw-src is-you"
                }
              >
                {away
                  ? ""
                  : signedIn
                    ? `Signed in as ${account.identity}`
                    : installed === undefined
                      ? `Needs ${tool.name} on this machine`
                      : "Not signed in"}
              </span>
              <span />
              <span className="fx-sw-act">
                {!away && !signedIn && installed !== undefined && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    aria-disabled={pending || undefined}
                    onClick={() => void signIn(machine.id, account.id)}
                  >
                    {pending ? (
                      <>
                        <span className="spin" /> Waiting…
                      </>
                    ) : (
                      "Sign in"
                    )}
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <p className="fx-accounts-note">
        Accounts with a key, such as OpenRouter, work on every machine and need no sign-in here.
      </p>
    </>
  );
}
