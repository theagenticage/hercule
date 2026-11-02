/**
 * PROTOTYPE - throwaway. Variant F, "Scope and concern": two choices, made
 * separately. The rail on the left picks the scope, the whole fleet or one
 * machine, as small cards that never leave the screen. The tabs in the bar
 * pick the concern, and mean the same in either scope: Capacity is the
 * fleet's ladders, or one machine's instruments. It keeps its shape at 5
 * machines and at 50, because the rail scrolls and the canvas does not grow.
 */
import { useRef, useState, type JSX, type ReactNode } from "react";
import { FleetIcon } from "../../icons/fleet";
import { PlusIcon } from "../../icons/plus";
import { Mark } from "../../marks/mark";
import { AddMachineDialog, CleanupDialog, MachineIcon, Meter, StatusDot } from "./fleet-atoms";
import {
  CapacityPanel,
  FleetLead,
  MachinePage,
  ReviewDialog,
  scrollToId,
  SoftwarePanel,
  StoragePanel,
  useScrollSpy,
  worstLevel,
} from "./fleet-blocks";
import {
  buildChanges,
  buildDiskParts,
  computeHeadroom,
  daysUntilFull,
  diskLevel,
  diskShare,
  findIssues,
  formatGB,
  idleWorkspaces,
  isAway,
  machineById,
  memoryLevel,
  memoryShare,
  setSlots,
  suggestSlots,
  toolKey,
  useFleet,
  type FleetState,
  type Machine,
  type MachineId,
} from "./fleet-world";
import "./variant-f.css";

type Concern = "overview" | "capacity" | "storage" | "software";

const CONCERNS: ReadonlyArray<{ readonly concern: Concern; readonly label: string }> = [
  { concern: "overview", label: "Overview" },
  { concern: "capacity", label: "Capacity" },
  { concern: "storage", label: "Storage" },
  { concern: "software", label: "Software" },
];

const sectionId = (scope: MachineId | null, concern: Concern): string =>
  scope === null ? `fx-${concern}` : concern === "overview" ? "fxf-top" : `fx-m-${concern}`;

export function VariantF(): JSX.Element {
  const fleet = useFleet();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<MachineId | null>(null);
  const [cleanupId, setCleanupId] = useState<MachineId | null>(null);
  const [review, setReview] = useState<{ readonly machineId: MachineId | undefined } | null>(null);
  const [adding, setAdding] = useState(false);
  const ids = CONCERNS.map((each) => sectionId(scope, each.concern));
  const current = useScrollSpy(canvasRef, ids, scope ?? "fleet", 60);
  const concern = CONCERNS[ids.indexOf(current)]?.concern ?? "overview";

  const pickScope = (next: MachineId | null) => {
    // The concern the user is reading stays the concern they read.
    const keep = concern;
    setScope(next);
    requestAnimationFrame(() => {
      if (keep === "overview") canvasRef.current?.scrollTo({ top: 0 });
      else scrollToId(canvasRef, sectionId(next, keep), false);
    });
  };

  return (
    <div className="fp-page fxf">
      <header className="bar">
        <h1 className="title">Fleet</h1>
        <nav className="tabs" aria-label="Concerns">
          {CONCERNS.map((each) => (
            <button
              key={each.concern}
              type="button"
              className={each.concern === concern ? "tab is-on" : "tab"}
              onClick={() => {
                if (each.concern === "overview")
                  canvasRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                else scrollToId(canvasRef, sectionId(scope, each.concern));
              }}
            >
              {each.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
          <PlusIcon size={14} /> Add a machine
        </button>
      </header>
      <div className="fxf-split">
        <Rail fleet={fleet} scope={scope} onPick={pickScope} />
        <div ref={canvasRef} className="fxf-canvas" key={scope ?? "fleet"}>
          {scope === null ? (
            <div className="fxf-col">
              <section id="fx-overview" className="fxf-overview">
                <FleetLead fleet={fleet} />
                <NeedsYou
                  fleet={fleet}
                  onPick={pickScope}
                  onCleanup={setCleanupId}
                  onReview={() => setReview({ machineId: undefined })}
                />
              </section>
              <CapacityPanel fleet={fleet} onOpen={pickScope} />
              <StoragePanel fleet={fleet} onCleanup={setCleanupId} onOpen={pickScope} />
              <SoftwarePanel fleet={fleet} onReview={(machineId) => setReview({ machineId })} />
            </div>
          ) : (
            <div className="fxf-col" id="fxf-top">
              <MachinePage
                fleet={fleet}
                machine={machineById(fleet, scope)}
                onCleanup={() => setCleanupId(scope)}
                onReview={() => setReview({ machineId: scope })}
              />
            </div>
          )}
        </div>
      </div>
      {cleanupId !== null && (
        <CleanupDialog machineId={cleanupId} onClose={() => setCleanupId(null)} />
      )}
      {review !== null && (
        <ReviewDialog machineId={review.machineId} onClose={() => setReview(null)} />
      )}
      {adding && <AddMachineDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

// ---------- The rail ----------

function Rail({
  fleet,
  scope,
  onPick,
}: {
  readonly fleet: FleetState;
  readonly scope: MachineId | null;
  readonly onPick: (scope: MachineId | null) => void;
}): JSX.Element {
  const needy = new Set(findIssues(fleet).map((issue) => issue.machineId));
  const online = fleet.machines.filter((each) => !isAway(each));
  const room = online.reduce((sum, each) => sum + computeHeadroom(each).room, 0);
  return (
    <aside className="fxf-rail" aria-label="Scope">
      <button
        type="button"
        className={scope === null ? "fxf-scope is-on" : "fxf-scope"}
        onClick={() => onPick(null)}
      >
        <span className="fxf-scope-icon">
          <FleetIcon size={16} />
        </span>
        <span className="fxf-scope-text">
          <b>All machines</b>
          <span>
            {needy.size > 0 && <span className="is-you">{needy.size} need you · </span>}
            room for {room} more
          </span>
        </span>
      </button>
      <h3 className="fxf-rail-h">
        Machines <span className="count">{fleet.machines.length}</span>
      </h3>
      {fleet.machines.map((machine) => (
        <RailCard
          key={machine.id}
          machine={machine}
          isOn={scope === machine.id}
          onPick={() => onPick(machine.id)}
        />
      ))}
    </aside>
  );
}

function RailCard({
  machine,
  isOn,
  onPick,
}: {
  readonly machine: Machine;
  readonly isOn: boolean;
  readonly onPick: () => void;
}): JSX.Element {
  const away = isAway(machine);
  const disk = away ? "ok" : diskLevel(machine);
  const days = daysUntilFull(machine);
  let note: ReactNode = null;
  if (away)
    note = <span className="is-fail">Unreachable since {machine.lastSeen.split(" ")[0]}</span>;
  else if (disk !== "ok") note = <span className="is-you">Disk full in ~{days ?? "?"} days</span>;
  else if (machine.queued > 0)
    note = <span className="is-you">{machine.queued} threads waiting</span>;
  return (
    <button
      type="button"
      className={`fxf-card${isOn ? " is-on" : ""}${away ? " is-away" : ""}`}
      onClick={onPick}
    >
      <span className="fxf-card-h">
        <MachineIcon machine={machine} size={14} />
        <b>{machine.name}</b>
        <StatusDot
          machine={machine}
          level={worstLevel(machine) === "crit" && !away ? "crit" : worstLevel(machine)}
        />
      </span>
      <span className="fxf-stats">
        <Stat
          label="Sessions"
          value={away ? "—" : `${machine.running}/${machine.slots}`}
          share={away ? 0 : machine.running / machine.slots}
          level={machine.queued > 0 ? "warn" : "ok"}
        />
        <Stat
          label="Disk"
          value={`${Math.round(diskShare(machine) * 100)}%`}
          share={diskShare(machine)}
          level={disk}
        />
        <Stat
          label="Memory"
          value={away ? "—" : `${Math.round(memoryShare(machine) * 100)}%`}
          share={away ? 0 : memoryShare(machine)}
          level={memoryLevel(machine)}
        />
      </span>
      {note !== null && <span className="fxf-note">{note}</span>}
    </button>
  );
}

function Stat({
  label,
  value,
  share,
  level,
}: {
  readonly label: string;
  readonly value: string;
  readonly share: number;
  readonly level: "ok" | "warn" | "crit";
}): JSX.Element {
  return (
    <span className={`fxf-stat is-${level}`}>
      <span>{label}</span>
      <b>{value}</b>
      <Meter value={share} level={level} height={3} />
    </span>
  );
}

// ---------- What needs you ----------

function NeedsYou({
  fleet,
  onPick,
  onCleanup,
  onReview,
}: {
  readonly fleet: FleetState;
  readonly onPick: (id: MachineId) => void;
  readonly onCleanup: (id: MachineId) => void;
  readonly onReview: () => void;
}): JSX.Element {
  const issues = findIssues(fleet);
  const changes = buildChanges(fleet);
  const applying = changes.some((change) =>
    fleet.pending.has(toolKey(change.tool.id, change.machine.id)),
  );
  const rows: ReactNode[] = issues.map((issue) => {
    const machine = machineById(fleet, issue.machineId);
    if (issue.kind === "offline") {
      return (
        <Row
          key={`${machine.id}-off`}
          state="failed"
          title={
            <>
              <b>{machine.name}</b> stopped answering on {machine.lastSeen}.
            </>
          }
          detail={`${machine.pinned} threads that started there wait for it. It may be asleep or off the network.`}
        >
          <button
            type="button"
            className="btn btn--sm btn--quiet"
            onClick={() => onPick(machine.id)}
          >
            Open
          </button>
        </Row>
      );
    }
    if (issue.kind === "disk") {
      const parts = buildDiskParts(machine, fleet.workspaces);
      const days = daysUntilFull(machine);
      return (
        <Row
          key={`${machine.id}-disk`}
          state="waiting"
          title={
            <>
              <b>{machine.name}</b>'s disk stops taking sessions in about {days} days.
            </>
          }
          detail={`${formatGB(parts.idle)} of it is in ${idleWorkspaces(machine.id, fleet.workspaces).length} workspaces nobody has used for two weeks. Cleaning up by itself, in Storage, would keep it from coming back.`}
        >
          <button type="button" className="btn btn--sm" onClick={() => onCleanup(machine.id)}>
            Clean up…
          </button>
        </Row>
      );
    }
    if (issue.kind === "slots") {
      const pending = fleet.pending.has(`slots:${machine.id}`);
      return (
        <Row
          key={`${machine.id}-slots`}
          state="waiting"
          title={
            <>
              <b>{machine.name}</b> has {machine.queued} threads waiting for a slot.
            </>
          }
          detail={`Its memory would hold ${computeHeadroom(machine).memory} more sessions, so a higher cap is safe.`}
        >
          <button
            type="button"
            className="btn btn--sm"
            aria-disabled={pending || undefined}
            onClick={() => void setSlots(machine.id, suggestSlots(machine))}
          >
            {pending ? (
              <>
                <span className="spin" /> Saving…
              </>
            ) : (
              `Allow ${suggestSlots(machine)} sessions`
            )}
          </button>
        </Row>
      );
    }
    return null;
  });
  if (changes.length > 0) {
    rows.push(
      <Row
        key="baseline"
        state="waiting"
        title={
          <>
            <b>{changes.length} installs</b> are out of line on{" "}
            {new Set(changes.map((change) => change.machine.id)).size} machines.
          </>
        }
        detail="Projects cannot run where their toolchain is missing, and older harnesses miss fixes."
      >
        <button
          type="button"
          className="btn btn--sm"
          aria-disabled={applying || undefined}
          onClick={onReview}
        >
          {applying ? (
            <>
              <span className="spin" /> Applying…
            </>
          ) : (
            "Review…"
          )}
        </button>
      </Row>,
    );
  }
  return <div className="fxf-needs">{rows}</div>;
}

function Row({
  state,
  title,
  detail,
  children,
}: {
  readonly state: "failed" | "waiting";
  readonly title: ReactNode;
  readonly detail: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="fxf-need">
      <Mark state={state} />
      <div className="fxf-need-text">
        <p>{title}</p>
        <span>{detail}</span>
      </div>
      <div className="fxf-need-act">{children}</div>
    </div>
  );
}
