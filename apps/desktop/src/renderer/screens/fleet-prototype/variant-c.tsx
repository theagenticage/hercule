/**
 * PROTOTYPE - throwaway. Variant C, "By concern": one page in three parts,
 * Capacity, Storage and Software, each comparing every machine on the same
 * scale. A problem shows where its number is, with its fix beside it.
 * Software is a matrix: tools down, machines across.
 */
import { useRef, useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { CheckIcon } from "../../icons/check";
import { PlusIcon } from "../../icons/plus";
import {
  AddMachineDialog,
  CleanupDialog,
  DiskBar,
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
  buildDiskParts,
  canInstall,
  daysUntilFull,
  diskLevel,
  diskShare,
  findGaps,
  formatGB,
  installTool,
  machinesToUpdate,
  memoryLevel,
  memoryShare,
  PROJECTS,
  readToolStatus,
  setSlots,
  slotsLevel,
  suggestSlots,
  TOOLS,
  toolKey,
  useFleet,
  type FleetState,
  type Level,
  type Machine,
  type MachineId,
  type Tool,
} from "./fleet-world";
import "../session/floating-header.css";
import "./variant-c.css";

type Part = "capacity" | "storage" | "software";

const worstLevel = (machine: Machine): Level => {
  if (machine.connectivity === "offline") return "crit";
  const levels = [diskLevel(machine), memoryLevel(machine), slotsLevel(machine)];
  return levels.includes("crit") ? "crit" : levels.includes("warn") ? "warn" : "ok";
};

export function VariantC(): JSX.Element {
  const fleet = useFleet();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [part, setPart] = useState<Part>("capacity");
  const [cleanupId, setCleanupId] = useState<MachineId | null>(null);
  const [adding, setAdding] = useState(false);

  const online = fleet.machines.filter((each) => each.connectivity === "online");
  const running = online.reduce((sum, each) => sum + each.running, 0);
  const slots = online.reduce((sum, each) => sum + each.slots, 0);
  const waiting = online.reduce((sum, each) => sum + each.queued, 0);
  const idle = fleet.machines.reduce(
    (sum, each) => sum + buildDiskParts(each, fleet.workspaces).idle,
    0,
  );
  const updates = TOOLS.reduce((sum, tool) => sum + machinesToUpdate(fleet, tool).length, 0);

  const jump = (next: Part) => {
    setPart(next);
    const target = scrollRef.current?.querySelector(`#fpc-${next}`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="fp-page fpc">
      <div className="top">
        <nav className="pill" aria-label="Fleet">
          <h1 className="pill-title">Fleet</h1>
          <button
            type="button"
            className={part === "capacity" ? "ptab is-on" : "ptab"}
            onClick={() => jump("capacity")}
          >
            Capacity{" "}
            <small>
              {running}/{slots}
            </small>
          </button>
          <button
            type="button"
            className={part === "storage" ? "ptab is-on" : "ptab"}
            onClick={() => jump("storage")}
          >
            Storage <small>{formatGB(idle)} idle</small>
          </button>
          <button
            type="button"
            className={part === "software" ? "ptab is-on" : "ptab"}
            onClick={() => jump("software")}
          >
            Software <small>{updates} behind</small>
          </button>
        </nav>
        <span className="spacer" />
        <nav className="pill">
          <button type="button" className="pill-btn" onClick={() => setAdding(true)}>
            <PlusIcon size={14} /> Add a machine
          </button>
        </nav>
      </div>
      <div
        ref={scrollRef}
        className="fp-scroll fpc-scroll"
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          const sections = (["capacity", "storage", "software"] as const).map((id) => ({
            id,
            top:
              (event.currentTarget.querySelector(`#fpc-${id}`) as HTMLElement | null)?.offsetTop ??
              0,
          }));
          const current = sections.filter((each) => each.top - 120 <= top).at(-1)?.id ?? "capacity";
          if (current !== part) setPart(current);
        }}
      >
        <div className="fpc-col">
          <p className="fpc-summary">
            <b>
              {online.length} of {fleet.machines.length}
            </b>{" "}
            machines online <i>·</i> <b>{running}</b> sessions running
            {waiting > 0 && (
              <>
                , <b className="is-you">{waiting} waiting</b>
              </>
            )}{" "}
            <i>·</i> <b>{formatGB(idle)}</b> in idle workspaces <i>·</i> <b>{updates}</b> installs
            behind
          </p>

          <Capacity fleet={fleet} />
          <Storage fleet={fleet} onCleanup={setCleanupId} />
          <Software fleet={fleet} />
        </div>
      </div>
      {cleanupId !== null && (
        <CleanupDialog machineId={cleanupId} onClose={() => setCleanupId(null)} />
      )}
      {adding && <AddMachineDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function Part({
  id,
  title,
  lead,
  aside,
  children,
}: {
  readonly id: Part;
  readonly title: string;
  readonly lead: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="fpc-part" id={`fpc-${id}`}>
      <div className="fpc-part-h">
        <div>
          <h2>{title}</h2>
          <p>{lead}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function MachineLabel({ machine }: { readonly machine: Machine }): JSX.Element {
  return (
    <span className="fpc-machine">
      <StatusDot
        machine={machine}
        level={
          worstLevel(machine) === "crit" && machine.connectivity !== "offline"
            ? "crit"
            : worstLevel(machine)
        }
      />
      <b>{machine.name}</b>
    </span>
  );
}

// ---------- Capacity ----------

function Capacity({ fleet }: { readonly fleet: FleetState }): JSX.Element {
  const widest = Math.max(...fleet.machines.map((each) => each.slots + each.queued));
  return (
    <Part
      id="capacity"
      title="Capacity"
      lead="Each block is one session slot. A thread resumes on the machine it started on, so a full machine makes its threads wait even when others are free."
    >
      <div className="fpc-rows" style={{ "--fpc-slots": widest } as CSSProperties}>
        <div className="fpc-cap-heads">
          <span />
          <span>Sessions</span>
          <span />
          <span>Memory</span>
          <span>CPU</span>
          <span />
        </div>
        {fleet.machines.map((machine) => {
          const offline = machine.connectivity === "offline";
          const pending = fleet.pending.has(`slots:${machine.id}`);
          const suggested = suggestSlots(machine);
          return (
            <div key={machine.id} className={offline ? "fpc-cap is-off" : "fpc-cap"}>
              <MachineLabel machine={machine} />
              <SlotPips machine={machine} size="lg" />
              <span className={machine.queued > 0 ? "fpc-num is-you" : "fpc-num"}>
                {offline ? "—" : `${machine.running} of ${machine.slots}`}
              </span>
              <span className="fpc-mem">
                {offline ? (
                  <span className="faint">—</span>
                ) : (
                  <>
                    <Meter value={memoryShare(machine)} level={memoryLevel(machine)} width={64} />
                    <span className="fpc-num">{Math.round(memoryShare(machine) * 100)}%</span>
                  </>
                )}
              </span>
              <span className="fpc-num">{offline ? "—" : `${machine.cpu}%`}</span>
              <span className="fpc-act">
                {offline ? (
                  <span className="fpc-why is-fail" title={`${machine.pinned} threads wait for it`}>
                    Offline since {machine.lastSeen}
                  </span>
                ) : machine.queued > 0 ? (
                  <>
                    <span
                      className="fpc-why is-you"
                      title={`${formatGB(machine.memoryFreeGB)} of memory free`}
                    >
                      {machine.queued} threads waiting
                    </span>
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
                  <span className="fpc-why">{machine.slots - machine.running} free</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </Part>
  );
}

// ---------- Storage ----------

function Storage({
  fleet,
  onCleanup,
}: {
  readonly fleet: FleetState;
  readonly onCleanup: (id: MachineId) => void;
}): JSX.Element {
  const scale = Math.max(...fleet.machines.map((each) => each.diskTotalGB));
  return (
    <Part
      id="storage"
      title="Storage"
      lead="Each bar is drawn to the disk's real size, so bigger disks draw longer bars. Below its disk limit, a machine takes no new sessions."
    >
      <div className="fpc-legend">
        <span>
          <Swatch part="inUse" /> In use
        </span>
        <span>
          <Swatch part="idle" /> Idle workspaces
        </span>
        <span>
          <Swatch part="caches" /> Caches
        </span>
        <span>
          <Swatch part="providerData" /> Session data
        </span>
        <span>
          <Swatch part="other" /> Not Hercule's
        </span>
        <span>
          <i className="fpc-legend-limit" /> Disk limit
        </span>
      </div>
      <div className="fpc-rows">
        {fleet.machines.map((machine) => {
          const offline = machine.connectivity === "offline";
          const parts = buildDiskParts(machine, fleet.workspaces);
          const days = daysUntilFull(machine);
          const level = diskLevel(machine);
          return (
            <div key={machine.id} className={offline ? "fpc-disk is-off" : "fpc-disk"}>
              <MachineLabel machine={machine} />
              <span
                className="fpc-disk-bar"
                style={{ "--fpc-ratio": machine.diskTotalGB / scale } as CSSProperties}
              >
                <span className="fpc-disk-fit">
                  <DiskBar machine={machine} parts={parts} height={16} />
                </span>
                <span className="fpc-disk-size">{formatGB(machine.diskTotalGB)}</span>
              </span>
              <span className="fpc-disk-num">
                <b className={level === "ok" || offline ? undefined : "is-you"}>
                  {Math.round(diskShare(machine) * 100)}% full
                </b>
                <span>
                  {days !== null && !offline ? (
                    <span className="is-you">Limit in {days} days</span>
                  ) : (
                    `${formatGB(machine.diskFreeGB)} free`
                  )}
                </span>
              </span>
              <span className="fpc-act">
                {offline ? (
                  <span className="fpc-why">As of {machine.lastSeen}</span>
                ) : (
                  <>
                    <span className={level === "ok" ? "fpc-why" : "fpc-why is-you"}>
                      {formatGB(parts.idle)} idle
                    </span>
                    <button
                      type="button"
                      className={level === "ok" ? "btn btn--sm btn--quiet" : "btn btn--sm"}
                      onClick={() => onCleanup(machine.id)}
                    >
                      Clean up…
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </Part>
  );
}

// ---------- Software ----------

function Software({ fleet }: { readonly fleet: FleetState }): JSX.Element {
  const harnesses = TOOLS.filter((tool) => tool.kind !== "toolchain");
  const toolchains = TOOLS.filter((tool) => tool.kind === "toolchain");
  return (
    <Part
      id="software"
      title="Software"
      lead="Hercule keeps every machine on the versions in the second column, and installs them for its own sessions with mise. It never changes the machine's own copies."
    >
      <div
        className="fpc-matrix"
        role="table"
        style={{ "--fpc-cols": fleet.machines.length } as CSSProperties}
      >
        <div className="fpc-mx-head" role="row">
          <span />
          <span>Target</span>
          {fleet.machines.map((machine) => (
            <span
              key={machine.id}
              className={
                machine.connectivity === "offline" ? "fpc-mx-machine is-off" : "fpc-mx-machine"
              }
            >
              <MachineIcon machine={machine} size={13} />
              {machine.name}
            </span>
          ))}
          <span />
        </div>
        <MatrixGroup title="Harnesses" />
        {harnesses.map((tool) => (
          <MatrixRow key={tool.id} fleet={fleet} tool={tool} />
        ))}
        <MatrixGroup title="Toolchains" />
        {toolchains.map((tool) => (
          <MatrixRow key={tool.id} fleet={fleet} tool={tool} />
        ))}
        <MatrixGroup title="Projects" />
        {PROJECTS.map((project) => (
          <div key={project.id} className="fpc-mx-row" role="row">
            <span className="fpc-mx-name">
              <ProjectDot project={project.id} />
              <b>{project.name}</b>
            </span>
            <span className="fpc-mx-target faint">can run?</span>
            {fleet.machines.map((machine) => {
              if (machine.connectivity === "offline") {
                return (
                  <span key={machine.id} className="fpc-cell is-unknown">
                    ?
                  </span>
                );
              }
              const gaps = findGaps(fleet, project.id, machine);
              return gaps.length === 0 ? (
                <span key={machine.id} className="fpc-cell is-yes" title="Can run here">
                  <CheckIcon size={13} />
                </span>
              ) : (
                <span
                  key={machine.id}
                  className="fpc-cell is-no"
                  title={gaps.map((gap) => `${gap.tool.name} ${gap.need.range}`).join(", ")}
                >
                  Needs {gaps.map((gap) => gap.tool.name).join(", ")}
                </span>
              );
            })}
            <span />
          </div>
        ))}
      </div>
    </Part>
  );
}

function MatrixGroup({ title }: { readonly title: string }): JSX.Element {
  return (
    <div className="fpc-mx-group" role="row">
      <span>{title}</span>
    </div>
  );
}

function MatrixRow({
  fleet,
  tool,
}: {
  readonly fleet: FleetState;
  readonly tool: Tool;
}): JSX.Element {
  const toUpdate = machinesToUpdate(fleet, tool);
  const neededMissing = fleet.machines.filter((machine) => {
    if (machine.connectivity === "offline") return false;
    const installed = fleet.installed[tool.id]?.[machine.id];
    return (
      tool.needs.some((need) => {
        const gaps = findGaps(fleet, need.project, machine);
        return gaps.some((gap) => gap.tool.id === tool.id);
      }) &&
      (installed === undefined || installed.version.split(".")[0] !== tool.target.split(".")[0])
    );
  });
  const fixAll = [...new Set([...toUpdate, ...neededMissing])].filter((machine) =>
    canInstall(tool, machine),
  );
  return (
    <div className="fpc-mx-row" role="row">
      <span className="fpc-mx-name">
        <ToolMark tool={tool} size={13} />
        <b>{tool.name}</b>
      </span>
      <span className="fpc-mx-target">{tool.target}</span>
      {fleet.machines.map((machine) => (
        <Cell key={machine.id} fleet={fleet} tool={tool} machine={machine} />
      ))}
      <span className="fpc-mx-act">
        {fixAll.length > 1 && (
          <ToolButton tool={tool} machines={fixAll} label={`Update ${fixAll.length}`} quiet />
        )}
      </span>
    </div>
  );
}

function Cell({
  fleet,
  tool,
  machine,
}: {
  readonly fleet: FleetState;
  readonly tool: Tool;
  readonly machine: Machine;
}): JSX.Element {
  const status = readToolStatus(fleet, tool, machine);
  const pending = fleet.pending.has(toolKey(tool.id, machine.id));
  const blocks = tool.needs.filter((need) =>
    findGaps(fleet, need.project, machine).some((gap) => gap.tool.id === tool.id),
  );
  if (pending) {
    return (
      <span className="fpc-cell is-pending">
        <span className="spin" /> {status.kind === "missing" ? "Installing" : "Updating"}
      </span>
    );
  }
  if (status.kind === "unknown") {
    return (
      <span className="fpc-cell is-unknown" title={`${machine.name} is offline`}>
        {status.installed?.version ?? "—"}
      </span>
    );
  }
  const fix = () => {
    if (canInstall(tool, machine)) void installTool(tool.id, [machine.id]);
  };
  if (status.kind === "missing") {
    if (blocks.length === 0) return <span className="fpc-cell is-none">—</span>;
    return canInstall(tool, machine) ? (
      <button
        type="button"
        className="fpc-cell is-no is-fix"
        onClick={fix}
        title={`${blocks.map((need) => need.project).join(", ")} needs it`}
      >
        <span className="fpc-cell-text">Missing</span>
        <span className="fpc-cell-hover">Install</span>
      </button>
    ) : (
      <span className="fpc-cell is-no" title="Install it on the machine by hand">
        Missing
      </span>
    );
  }
  const { installed } = status;
  if (blocks.length > 0) {
    return (
      <button
        type="button"
        className="fpc-cell is-no is-fix"
        onClick={fix}
        title={`${blocks.map((need) => `${need.project} needs ${need.range}`).join(", ")}`}
      >
        <span className="fpc-cell-text">{installed.version}</span>
        <span className="fpc-cell-hover">Install {tool.target}</span>
      </button>
    );
  }
  if (status.kind === "older") {
    return (
      <button
        type="button"
        className="fpc-cell is-older is-fix"
        onClick={fix}
        title={installed.source === "machine" ? "The machine's own copy" : "Installed by Hercule"}
      >
        <span className="fpc-cell-text">{installed.version}</span>
        <span className="fpc-cell-hover">Update</span>
      </button>
    );
  }
  return (
    <span
      className="fpc-cell is-current"
      title={`${installed.version}, ${installed.source === "machine" ? "the machine's own" : "installed by Hercule"}`}
    >
      {installed.version === tool.target ? <CheckIcon size={13} /> : installed.version}
    </span>
  );
}
