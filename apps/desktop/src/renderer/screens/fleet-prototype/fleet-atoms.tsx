/**
 * PROTOTYPE - throwaway. The small pieces every Fleet variant draws with:
 * meters, slot pips, the disk bar, the update button, the cleanup dialog,
 * the Add a machine dialog and the toast. The layouts are each variant's own.
 */
import { useEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { CheckIcon } from "../../icons/check";
import { CopyIcon } from "../../icons/copy";
import { LaptopIcon } from "../../icons/laptop";
import { ServerIcon } from "../../icons/server";
import { LogoMark } from "../../logos";
import { GlassDialog } from "../glass-dialog";
import { ProviderLogo } from "../thread/provider-logo";
import {
  buildDiskParts,
  canInstall,
  dismissToast,
  formatDays,
  formatGB,
  idleWorkspaces,
  installTool,
  PROJECT_TINT,
  removeWorkspaces,
  toolKey,
  useFleet,
  type DiskParts,
  type Level,
  type Machine,
  type MachineId,
  type Tool,
  type Workspace,
} from "./fleet-world";
import "./fleet-atoms.css";

export function MachineIcon({
  machine,
  size = 16,
}: {
  readonly machine: Machine;
  readonly size?: number;
}): JSX.Element {
  return machine.kind === "laptop" ? <LaptopIcon size={size} /> : <ServerIcon size={size} />;
}

/** A tool's mark: the provider's logo for a harness, nothing for the rest. */
export function ToolMark({
  tool,
  size = 14,
}: {
  readonly tool: Tool;
  readonly size?: number;
}): JSX.Element | null {
  if (tool.kind === "runner") {
    return (
      <span className="fp-tool-mark" style={{ width: size, height: size }}>
        <LogoMark size={size + 2} />
      </span>
    );
  }
  if (tool.kind !== "harness") return null;
  return (
    <span className="fp-tool-mark" style={{ width: size, height: size }}>
      <ProviderLogo providerId={tool.id} size={size} />
    </span>
  );
}

/**
 * The dot before a machine's name: green while it works normally, marigold
 * while something on it needs the user, tomato while it is offline, and a
 * ring while it takes no new work.
 */
export function StatusDot({
  machine,
  level,
}: {
  readonly machine: Machine;
  readonly level: Level;
}): JSX.Element {
  const tone =
    machine.connectivity === "offline"
      ? "off"
      : machine.lifecycle === "draining"
        ? "drain"
        : level === "ok"
          ? "ok"
          : level;
  return <i className={`fp-dot fp-dot--${tone}`} aria-hidden="true" />;
}

/** The words for a machine's state, as the dot's partner. */
export const describeState = (machine: Machine): string =>
  machine.connectivity === "offline"
    ? `Offline since ${machine.lastSeen}`
    : machine.lifecycle === "draining"
      ? "Taking no new work"
      : "Online";

/** A bar showing how full something is. `value` runs from 0 to 1. */
export function Meter({
  value,
  level = "ok",
  height = 4,
  width,
}: {
  readonly value: number;
  readonly level?: Level;
  readonly height?: number;
  readonly width?: number | string;
}): JSX.Element {
  return (
    <span className={`fp-meter fp-meter--${level}`} style={{ height, width }}>
      <i style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }} />
    </span>
  );
}

/**
 * One pip per session slot: filled while a session runs in it, hollow while
 * it is free, then a marigold pip for each thread waiting for a slot.
 */
export function SlotPips({
  machine,
  size = "sm",
}: {
  readonly machine: Machine;
  readonly size?: "sm" | "lg";
}): JSX.Element {
  const offline = machine.connectivity === "offline";
  if (machine.slots > MAX_SLOT_BLOCKS) {
    return (
      <SessionBar
        slots={machine.slots}
        running={offline ? 0 : machine.running}
        waiting={machine.queued}
        away={offline}
        height={size === "lg" ? 20 : 10}
      />
    );
  }
  return (
    <span className={`fp-pips fp-pips--${size}${offline ? " is-off" : ""}`} aria-hidden="true">
      {Array.from({ length: machine.slots }, (_, index) => (
        <i key={index} className={index < machine.running ? "is-run" : undefined} />
      ))}
      {machine.queued > 0 && <b className="fp-pips-gap" />}
      {Array.from({ length: machine.queued }, (_, index) => (
        <i key={`q${index}`} className="is-wait" />
      ))}
    </span>
  );
}

/** The most slots drawn as one block each. Past it, a machine's sessions are drawn as a bar. */
export const MAX_SLOT_BLOCKS = 16;

/**
 * A machine's sessions as one bar, for a machine with more slots than
 * blocks can show. The part up to the cap holds the running sessions from
 * the left, then the free slots, then, hatched, free slots with no memory
 * for a session. After the cap's rule come the threads waiting for a slot,
 * in marigold, and, dashed, the sessions memory would hold past the cap. A
 * thin cut every 10 sessions keeps the bar countable at a glance.
 */
export function SessionBar({
  slots,
  running,
  waiting = 0,
  starved = 0,
  could = 0,
  away = false,
  height = 10,
}: {
  readonly slots: number;
  readonly running: number;
  readonly waiting?: number;
  readonly starved?: number;
  readonly could?: number;
  readonly away?: boolean;
  readonly height?: number;
}): JSX.Element {
  const total = slots + waiting + could;
  const share = (count: number) => `${(count / total) * 100}%`;
  const inCap = (count: number) => `${(count / slots) * 100}%`;
  return (
    <span
      className={away ? "fp-sbar is-away" : "fp-sbar"}
      style={{ height } as CSSProperties}
      aria-hidden="true"
    >
      <span
        className="fp-sbar-cap"
        style={{ width: share(slots), "--fp-cut": inCap(10) } as CSSProperties}
      >
        <i className="is-run" style={{ width: inCap(running) }} />
        <i style={{ width: inCap(slots - running - starved) }} />
        <i className="is-starved" style={{ width: inCap(starved) }} />
      </span>
      {(waiting > 0 || could > 0) && <b className="fp-sbar-rule" />}
      {waiting > 0 && <i className="is-wait" style={{ width: share(waiting) }} />}
      {could > 0 && <i className="is-could" style={{ width: share(could) }} />}
    </span>
  );
}

export const DISK_PARTS: ReadonlyArray<{
  readonly key: keyof DiskParts;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    key: "inUse",
    label: "Workspaces in use",
    hint: "Used in the last two weeks, or by a running thread",
  },
  { key: "idle", label: "Idle workspaces", hint: "Nobody has used them for two weeks or more" },
  {
    key: "caches",
    label: "Repository caches",
    hint: "One copy of each repository, so new workspaces start fast",
  },
  { key: "providerData", label: "Session data", hint: "Transcripts, harness homes and logs" },
  { key: "other", label: "Not Hercule's", hint: "Everything else on the disk" },
];

/**
 * A machine's disk as one bar, split into what holds it. With `scaleGB`, the
 * bar's length is the disk's size against that scale, so the bars of several
 * machines compare in gigabytes rather than in shares.
 */
export function DiskBar({
  machine,
  parts,
  height = 8,
  scaleGB,
  split = false,
}: {
  readonly machine: Machine;
  readonly parts: DiskParts;
  readonly height?: number;
  readonly scaleGB?: number;
  readonly split?: boolean;
}): JSX.Element {
  const total = machine.diskTotalGB;
  const segments: Array<{ key: string; gb: number }> = [
    { key: "inUse", gb: parts.inUse },
    ...(split
      ? [
          { key: "idleClean", gb: parts.idleClean },
          { key: "idleDirty", gb: parts.idleDirty },
        ]
      : [{ key: "idle", gb: parts.idle }]),
    { key: "caches", gb: parts.caches },
    { key: "providerData", gb: parts.providerData + parts.logs },
    { key: "other", gb: parts.other },
  ];
  const watermark = machine.diskWatermarkGB / total;
  return (
    <span
      className={`fp-disk${machine.connectivity === "offline" ? " is-off" : ""}`}
      data-needs="workspace sizes"
      style={{ height, width: scaleGB === undefined ? undefined : `${(total / scaleGB) * 100}%` }}
      aria-hidden="true"
    >
      {segments.map(({ key, gb }) => (
        <i
          key={key}
          className={`fp-seg fp-seg--${key}`}
          style={{ width: `${(gb / total) * 100}%` }}
        />
      ))}
      <b className="fp-disk-mark" style={{ right: `${watermark * 100}%` }} />
    </span>
  );
}

/** The swatch of one part of the disk, for a legend. */
export function Swatch({ part }: { readonly part: string }): JSX.Element {
  return <i className={`fp-swatch fp-seg--${part}`} aria-hidden="true" />;
}

/**
 * The button that installs or updates `tool` on `machines`: its label, then
 * a spinner while the work runs, then a check once the tool is current.
 */
export function ToolButton({
  tool,
  machines,
  label,
  quiet = false,
}: {
  readonly tool: Tool;
  readonly machines: ReadonlyArray<Machine>;
  readonly label: string;
  readonly quiet?: boolean;
}): JSX.Element | null {
  const fleet = useFleet();
  const pending = machines.some((machine) => fleet.pending.has(toolKey(tool.id, machine.id)));
  const installable = machines.filter((machine) => canInstall(tool, machine));
  if (machines.length === 0) return null;
  if (installable.length === 0) {
    return (
      <span
        className="fp-by-hand"
        title="Hercule cannot install it itself. Install it on the machine, and Hercule finds it."
      >
        Install by hand
      </span>
    );
  }
  return (
    <button
      type="button"
      className={quiet ? "btn btn--sm btn--quiet" : "btn btn--sm"}
      aria-disabled={pending || undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (!pending)
          void installTool(
            tool.id,
            installable.map((machine) => machine.id),
          );
      }}
    >
      {pending ? (
        <>
          <span className="spin" /> {label.startsWith("Install") ? "Installing" : "Updating"}…
        </>
      ) : (
        label
      )}
    </button>
  );
}

/** The version of a tool, with its source, as a row's quiet second part. */
export function VersionText({
  version,
  older,
}: {
  readonly version: string;
  readonly older: boolean;
}): JSX.Element {
  return <span className={older ? "fp-ver is-older" : "fp-ver"}>{version}</span>;
}

/** A workspace's project, as the tint of its inlay. */
export function ProjectDot({ project }: { readonly project: Workspace["project"] }): JSX.Element {
  return (
    <i
      className="fp-proj"
      style={{ background: PROJECT_TINT[project] } as CSSProperties}
      aria-hidden="true"
    />
  );
}

// ---------- The cleanup dialog ----------

const SHOWN_ROWS = 6;

/**
 * Renders the dialog that removes a machine's idle workspaces. Removing a
 * workspace archives the threads that worked in it, which is final. When it
 * opens, the runner re-checks the idle workspaces for uncommitted files.
 *
 * - Threads Done: picked at first.
 * - Threads not Done: listed apart, not picked, because removing one also
 *   marks its threads Done and archives them.
 * - Uncommitted changes: not picked; removing one discards them.
 *
 * Workspaces in use are never offered, and neither is a run's workspace,
 * which Hercule removes by itself.
 */
export function CleanupDialog({
  machineId,
  onClose,
}: {
  readonly machineId: MachineId;
  readonly onClose: () => void;
}): JSX.Element {
  const fleet = useFleet();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const machine = fleet.machines.find((each) => each.id === machineId)!;
  // The list as the dialog opened: a removal closes the dialog.
  const [idle] = useState(() =>
    idleWorkspaces(machineId, fleet.workspaces).toSorted((a, b) => b.freesGB - a.freesGB),
  );
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setChecking(false), 800);
    return () => clearTimeout(timer);
  }, []);
  const done = idle.filter((each) => each.changes === 0 && each.threadsDone);
  const notDone = idle.filter((each) => each.changes === 0 && !each.threadsDone);
  const dirty = idle.filter((each) => each.changes > 0);
  const inUse = fleet.workspaces.filter(
    (each) => each.machineId === machineId && !idle.includes(each),
  );
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(done.map((each) => each.id)),
  );
  const pending = fleet.pending.has(`cleanup:${machineId}`);
  const pickedList = idle.filter((each) => picked.has(each.id));
  const pickedGB = pickedList.reduce((sum, each) => sum + each.freesGB, 0);
  const pickedDirty = pickedList.filter((each) => each.changes > 0).length;
  const parts = buildDiskParts(machine, fleet.workspaces);
  const freeAfter = machine.diskFreeGB + pickedGB;

  const toggle = (ids: ReadonlyArray<string>, on: boolean) => {
    const next = new Set(picked);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setPicked(next);
  };

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="fp-cleanup"
      label={`Clean up ${machine.name}`}
      onClose={onClose}
    >
      <div className="pop-h fp-cleanup-h">
        <b>Clean up {machine.name}</b>
        <span data-needs="workspace sizes">
          Frees up to {formatGB(parts.idle)} from {idle.length} idle workspaces
        </span>
      </div>
      <div className="fp-cleanup-body">
        <p className="fp-cleanup-lead">
          Removing a workspace deletes its folder and <b>archives the threads</b> that worked in it.
          They stay readable, but can never run again. Pushed branches stay on GitHub.
        </p>
        {checking ? (
          <p className="fp-cleanup-checking">
            <span className="spin" /> Checking {idle.length} workspaces for uncommitted files…
          </p>
        ) : (
          <>
            <CleanupGroup
              title="Threads Done"
              hint="Not used for a week or more, and every thread in them is Done."
              rows={done}
              picked={picked}
              onToggle={toggle}
            />
            {notDone.length > 0 && (
              <CleanupGroup
                title="Threads not Done"
                hint="Some threads here are not Done. Removing marks them Done and archives them."
                rows={notDone}
                picked={picked}
                onToggle={toggle}
              />
            )}
            {dirty.length > 0 && (
              <CleanupGroup
                title="Uncommitted changes"
                hint="Their changes were never committed. Removing one discards them."
                rows={dirty}
                picked={picked}
                onToggle={toggle}
              />
            )}
            <p className="fp-cleanup-kept">
              <CheckIcon size={14} /> {inUse.length} workspaces used this week stay, and so do the
              workspaces of runs, which Hercule removes by itself.
            </p>
          </>
        )}
      </div>
      <div className="fp-cleanup-foot">
        <span className="fp-cleanup-sum">
          Frees <b>{formatGB(pickedGB)}</b>
          <span className="faint">
            {" "}
            · archives {pickedList.length} {pickedList.length === 1 ? "thread" : "threads"} · can't
            be undone
          </span>
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn--quiet" onClick={() => dialogRef.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--danger"
          data-unready={checking || pickedList.length === 0 || undefined}
          aria-disabled={pending || undefined}
          title={`${formatGB(machine.diskFreeGB)} free now, ${formatGB(freeAfter)} after`}
          onClick={async () => {
            if (pending || checking || pickedList.length === 0) return;
            await removeWorkspaces(machineId, picked);
            dialogRef.current?.close();
          }}
        >
          {pending ? (
            <>
              <span className="spin" /> Removing…
            </>
          ) : pickedDirty > 0 ? (
            `Archive and remove ${pickedList.length}, discarding changes in ${pickedDirty}`
          ) : (
            `Archive and remove ${pickedList.length}`
          )}
        </button>
      </div>
    </GlassDialog>
  );
}

function CleanupGroup({
  title,
  hint,
  rows,
  picked,
  onToggle,
}: {
  readonly title: string;
  readonly hint: string;
  readonly rows: ReadonlyArray<Workspace>;
  readonly picked: ReadonlySet<string>;
  readonly onToggle: (ids: ReadonlyArray<string>, on: boolean) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, SHOWN_ROWS);
  const pickedHere = rows.filter((each) => picked.has(each.id));
  const allPicked = pickedHere.length === rows.length;
  const frees = rows.reduce((sum, each) => sum + each.freesGB, 0);
  return (
    <section className="fp-cg">
      <label className="fp-cg-h">
        <span className="choice-box">
          <input
            type="checkbox"
            checked={allPicked}
            ref={(input) => {
              if (input !== null) input.indeterminate = pickedHere.length > 0 && !allPicked;
            }}
            onChange={(event) =>
              onToggle(
                rows.map((each) => each.id),
                event.target.checked,
              )
            }
          />
          <CheckIcon size={12} />
        </span>
        <span className="fp-cg-title">
          <b>{title}</b>
          <span>{hint}</span>
        </span>
        <span className="fp-cg-size">
          {rows.length} · frees {formatGB(frees)}
        </span>
      </label>
      <div className="fp-cg-rows">
        {shown.map((each) => (
          <label key={each.id} className="fp-cg-row">
            <span className="choice-box">
              <input
                type="checkbox"
                checked={picked.has(each.id)}
                onChange={(event) => onToggle([each.id], event.target.checked)}
              />
              <CheckIcon size={12} />
            </span>
            <ProjectDot project={each.project} />
            <span className="fp-cg-name">
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
            <span className="fp-cg-age">{formatDays(each.lastUsedDays)}</span>
            <span
              className="fp-cg-gb"
              title={`${formatGB(each.sizeGB)} on disk; removing it frees ${formatGB(each.freesGB)}`}
            >
              {formatGB(each.freesGB)}
            </span>
          </label>
        ))}
        {rows.length > SHOWN_ROWS && (
          <button type="button" className="fp-cg-more" onClick={() => setOpen(!open)}>
            {open ? "Show fewer" : `Show ${rows.length - SHOWN_ROWS} more`}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------- Add a machine ----------

export function AddMachineDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const command =
    "curl -fsSL https://atlas.tail3c1e.ts.net:7420/install | sh -s -- join hjt_8Kq2vX…";
  return (
    <GlassDialog dialogRef={dialogRef} className="fp-add" label="Add a machine" onClose={onClose}>
      <div className="pop-h">
        <b>Add a machine</b>
      </div>
      <div className="fp-add-body">
        <p>
          On the new machine, open a terminal and run this. It installs Hercule and joins this
          fleet.
        </p>
        <div className="fp-cmd">
          <code>{command}</code>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Copy"
            onClick={() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </button>
        </div>
        <p className="fp-add-wait">
          <span className="spin" /> Waiting for the machine. The command works once, for the next 24
          hours.
        </p>
      </div>
      <div className="fp-add-foot">
        <span className="faint">1 earlier invitation is still open, from yesterday.</span>
        <button type="button" className="btn btn--sm btn--quiet">
          Revoke it
        </button>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
          Done
        </button>
      </div>
    </GlassDialog>
  );
}

// ---------- The toast ----------

export function FleetToast(): JSX.Element | null {
  const { toast } = useFleet();
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(dismissToast, 4200);
    return () => clearTimeout(timer);
  }, [toast]);
  if (toast === null) return null;
  return (
    <div key={toast.id} className="fp-toast" role="status">
      <CheckIcon size={14} />
      <span>{toast.text}.</span>
    </div>
  );
}

/** A small heading over a group, in the list's caps, with a count. */
export function GroupHeading({
  children,
  count,
  you = false,
  aside,
}: {
  readonly children: ReactNode;
  readonly count?: number;
  readonly you?: boolean;
  readonly aside?: ReactNode;
}): JSX.Element {
  return (
    <h3 className="fp-gh">
      <span>{children}</span>
      {count !== undefined && <span className={you ? "count count--you" : "count"}>{count}</span>}
      {aside !== undefined && <span className="fp-gh-aside">{aside}</span>}
    </h3>
  );
}
