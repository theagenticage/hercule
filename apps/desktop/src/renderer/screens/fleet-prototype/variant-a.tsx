/**
 * PROTOTYPE - throwaway. Variant A, "Board": the fleet as one table under
 * what needs you. A row opens the machine in a pane beside the table, where
 * everything about it can be changed. Software is a list of things to do.
 */
import { useState, type JSX, type ReactNode } from "react";
import { Face } from "../../faces";
import { buildSessionLook } from "../../faces/look";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { CloseIcon } from "../../icons/close";
import { MoreIcon } from "../../icons/more";
import { PlusIcon } from "../../icons/plus";
import { Mark } from "../../marks/mark";
import {
  AddMachineDialog,
  CleanupDialog,
  DiskBar,
  describeState,
  GroupHeading,
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
  CONTROLLER_VERSION,
  daysUntilFull,
  diskLevel,
  diskShare,
  findGaps,
  findIssues,
  formatGB,
  idleWorkspaces,
  installTool,
  machineById,
  machinesToUpdate,
  memoryLevel,
  memoryShare,
  PROJECTS,
  readToolStatus,
  setDraining,
  setSlots,
  slotsLevel,
  suggestSlots,
  TOOLS,
  TOOL_BY_ID,
  useFleet,
  type FleetState,
  type Issue,
  type Level,
  type Machine,
  type MachineId,
} from "./fleet-world";
import "./variant-a.css";

const worstLevel = (machine: Machine): Level => {
  const levels = [diskLevel(machine), memoryLevel(machine), slotsLevel(machine)];
  return levels.includes("crit") ? "crit" : levels.includes("warn") ? "warn" : "ok";
};

export function VariantA(): JSX.Element {
  const fleet = useFleet();
  const [tab, setTab] = useState<"machines" | "software">("machines");
  const [openId, setOpenId] = useState<MachineId | null>("beelink");
  const [cleanupId, setCleanupId] = useState<MachineId | null>(null);
  const [adding, setAdding] = useState(false);
  const updates = TOOLS.filter((tool) => machinesToUpdate(fleet, tool).length > 0).length;

  return (
    <div className="fp-page fpa">
      <header className="bar">
        <h1 className="title">Fleet</h1>
        <nav className="tabs" aria-label="Fleet views">
          <button
            type="button"
            className={tab === "machines" ? "tab is-on" : "tab"}
            onClick={() => setTab("machines")}
          >
            Machines <small>{fleet.machines.length}</small>
          </button>
          <button
            type="button"
            className={tab === "software" ? "tab is-on" : "tab"}
            onClick={() => setTab("software")}
          >
            Software {updates > 0 && <small>{updates} updates</small>}
          </button>
        </nav>
        <span className="spacer" />
        <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
          <PlusIcon size={14} /> Add a machine
        </button>
      </header>
      {tab === "machines" ? (
        <div className={openId === null ? "fpa-split" : "fpa-split has-pane"}>
          <div className="fpa-board">
            <Board fleet={fleet} openId={openId} onOpen={setOpenId} onCleanup={setCleanupId} />
          </div>
          {openId !== null && (
            <MachinePane
              key={openId}
              fleet={fleet}
              machine={machineById(fleet, openId)}
              onClose={() => setOpenId(null)}
              onCleanup={() => setCleanupId(openId)}
            />
          )}
        </div>
      ) : (
        <div className="fpa-split">
          <div className="fpa-board">
            <SoftwareToDo fleet={fleet} />
          </div>
        </div>
      )}
      {cleanupId !== null && (
        <CleanupDialog machineId={cleanupId} onClose={() => setCleanupId(null)} />
      )}
      {adding && <AddMachineDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

// ---------- The board ----------

function Board({
  fleet,
  openId,
  onOpen,
  onCleanup,
}: {
  readonly fleet: FleetState;
  readonly openId: MachineId | null;
  readonly onOpen: (id: MachineId) => void;
  readonly onCleanup: (id: MachineId) => void;
}): JSX.Element {
  const online = fleet.machines.filter((each) => each.connectivity === "online");
  const running = online.reduce((sum, each) => sum + each.running, 0);
  const slots = online.reduce((sum, each) => sum + each.slots, 0);
  const waiting = online.reduce((sum, each) => sum + each.queued, 0);
  const idle = fleet.machines.reduce(
    (sum, each) => sum + buildDiskParts(each, fleet.workspaces).idle,
    0,
  );
  const issues = findIssues(fleet);

  return (
    <div className="fpa-inner">
      <div className="fpa-stats">
        <Stat value={online.length} of={fleet.machines.length} label="machines online" />
        <Stat value={running} of={slots} label="sessions running" />
        <Stat
          value={waiting}
          label={waiting === 1 ? "thread waiting for a slot" : "threads waiting for a slot"}
          you={waiting > 0}
        />
        <Stat value={formatGB(idle)} label="in idle workspaces" />
      </div>

      {issues.length > 0 && (
        <section className="fpa-sec">
          <GroupHeading count={issues.length} you>
            Needs you
          </GroupHeading>
          <div className="fpa-issues">
            {issues.map((issue) => (
              <IssueRow
                key={`${issue.machineId}-${issue.kind}`}
                fleet={fleet}
                issue={issue}
                onOpen={() => onOpen(issue.machineId)}
                onCleanup={() => onCleanup(issue.machineId)}
              />
            ))}
          </div>
        </section>
      )}

      <section className="fpa-sec">
        <GroupHeading count={fleet.machines.length}>Machines</GroupHeading>
        <div className="fpa-table" role="table">
          <div className="fpa-heads" role="row">
            <span />
            <span>Machine</span>
            <span>Sessions</span>
            <span>Disk</span>
            <span className="fpa-col-mem">Memory</span>
            <span className="fpa-col-sw">Harnesses</span>
            <span />
          </div>
          {fleet.machines.map((machine) => (
            <MachineRow
              key={machine.id}
              fleet={fleet}
              machine={machine}
              isOpen={machine.id === openId}
              onOpen={() => onOpen(machine.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({
  value,
  of,
  label,
  you = false,
}: {
  readonly value: number | string;
  readonly of?: number;
  readonly label: string;
  readonly you?: boolean;
}): JSX.Element {
  return (
    <div className={you ? "fpa-stat is-you" : "fpa-stat"}>
      <b>
        {value}
        {of !== undefined && <small> of {of}</small>}
      </b>
      <span>{label}</span>
    </div>
  );
}

function IssueRow({
  fleet,
  issue,
  onOpen,
  onCleanup,
}: {
  readonly fleet: FleetState;
  readonly issue: Issue;
  readonly onOpen: () => void;
  readonly onCleanup: () => void;
}): JSX.Element {
  const machine = machineById(fleet, issue.machineId);
  const pendingSlots = fleet.pending.has(`slots:${machine.id}`);
  let title: ReactNode;
  let detail: ReactNode;
  let actions: ReactNode = null;
  if (issue.kind === "offline") {
    title = (
      <>
        <b>{machine.name}</b> has been offline since {machine.lastSeen}.
      </>
    );
    detail = `${machine.pinned} threads started there and cannot resume until it is back. Start the machine, or retire it.`;
    actions = (
      <button type="button" className="btn btn--sm btn--quiet" onClick={onOpen}>
        Details
      </button>
    );
  } else if (issue.kind === "disk") {
    const parts = buildDiskParts(machine, fleet.workspaces);
    const days = daysUntilFull(machine);
    const count = idleWorkspaces(machine.id, fleet.workspaces).length;
    title = (
      <>
        <b>{machine.name}</b>'s disk is {Math.round(diskShare(machine) * 100)}% full
        {days !== null && (
          <>, and fills by about {Math.round(-machine.diskTrendGBPerDay)} GB a day</>
        )}
        .
      </>
    );
    detail = `${formatGB(parts.idle)} of it is in ${count} workspaces nobody has used for two weeks.${days !== null ? ` At this rate it stops taking sessions in ${days} days.` : ""}`;
    actions = (
      <button type="button" className="btn btn--sm" onClick={onCleanup}>
        Clean up…
      </button>
    );
  } else if (issue.kind === "slots") {
    const suggested = suggestSlots(machine);
    title = (
      <>
        <b>{machine.name}</b> is running all {machine.slots} sessions, and {machine.queued} threads
        are waiting for it.
      </>
    );
    detail = `They resume where they started. It has ${formatGB(machine.memoryFreeGB)} of memory free, enough for ${suggested - machine.slots} more.`;
    actions = (
      <button
        type="button"
        className="btn btn--sm"
        aria-disabled={pendingSlots || undefined}
        onClick={() => void setSlots(machine.id, suggested)}
      >
        {pendingSlots ? (
          <>
            <span className="spin" /> Saving…
          </>
        ) : (
          `Allow ${suggested} sessions`
        )}
      </button>
    );
  } else {
    title = (
      <>
        <b>{machine.name}</b> is low on memory.
      </>
    );
    detail = `${formatGB(machine.memoryFreeGB)} free of ${formatGB(machine.memoryTotalGB)}.`;
  }
  return (
    <div className="fpa-issue">
      <Mark state={issue.level === "crit" ? "failed" : "waiting"} />
      <div className="fpa-issue-text">
        <p>{title}</p>
        <span>{detail}</span>
      </div>
      <div className="fpa-issue-acts">{actions}</div>
    </div>
  );
}

function MachineRow({
  fleet,
  machine,
  isOpen,
  onOpen,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly isOpen: boolean;
  readonly onOpen: () => void;
}): JSX.Element {
  const offline = machine.connectivity === "offline";
  const disk = diskLevel(machine);
  const memory = memoryLevel(machine);
  const harnesses = TOOLS.filter((tool) => tool.kind === "harness");
  return (
    <button
      type="button"
      role="row"
      className={`fpa-row${isOpen ? " is-open" : ""}${offline ? " is-off" : ""}`}
      onClick={onOpen}
    >
      <StatusDot machine={machine} level={worstLevel(machine)} />
      <span className="fpa-name">
        <b>
          {machine.name}
          {machine.isLocal && <small>This Mac</small>}
        </b>
        <span>
          {machine.model} · {machine.os}
        </span>
      </span>
      {offline ? (
        <span className="fpa-offline">
          {describeState(machine)}
          <span> · {machine.pinned} threads waiting for it</span>
        </span>
      ) : (
        <>
          <span className="fpa-cell">
            <SlotPips machine={machine} />
            <span className={machine.queued > 0 ? "fpa-sub is-you" : "fpa-sub"}>
              {machine.running} of {machine.slots}
              {machine.queued > 0 && ` · ${machine.queued} waiting`}
            </span>
          </span>
          <span className="fpa-cell">
            <span className="fpa-meter-line">
              <Meter value={diskShare(machine)} level={disk} width={76} />
              <span className={disk === "ok" ? "fpa-pct" : "fpa-pct is-you"}>
                {Math.round(diskShare(machine) * 100)}%
              </span>
            </span>
            <span className="fpa-sub">{formatGB(machine.diskFreeGB)} free</span>
          </span>
          <span className="fpa-cell fpa-col-mem">
            <span className="fpa-meter-line">
              <Meter value={memoryShare(machine)} level={memory} width={76} />
              <span className="fpa-pct">{Math.round(memoryShare(machine) * 100)}%</span>
            </span>
            <span className="fpa-sub">{formatGB(machine.memoryFreeGB)} free</span>
          </span>
          <span className="fpa-harness fpa-col-sw">
            {harnesses.map((tool) => {
              const status = readToolStatus(fleet, tool, machine);
              if (status.kind === "missing") return null;
              const older = status.kind === "older";
              return (
                <span key={tool.id} className={older ? "is-older" : undefined} title={tool.name}>
                  <ToolMark tool={tool} size={12} />
                  {status.kind === "unknown" ? "?" : status.installed.version}
                </span>
              );
            })}
          </span>
        </>
      )}
      <ChevronRightIcon size={14} />
    </button>
  );
}

// ---------- The pane ----------

function MachinePane({
  fleet,
  machine,
  onClose,
  onCleanup,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly onClose: () => void;
  readonly onCleanup: () => void;
}): JSX.Element {
  const offline = machine.connectivity === "offline";
  const parts = buildDiskParts(machine, fleet.workspaces);
  const days = daysUntilFull(machine);
  const running = fleet.workspaces.filter((each) => each.machineId === machine.id && each.inUse);
  const [showAllTools, setShowAllTools] = useState(false);
  const toolchains = TOOLS.filter((tool) => tool.kind === "toolchain");
  const toolRows = toolchains.filter((tool) => {
    const status = readToolStatus(fleet, tool, machine);
    const needed = tool.needs.length > 0;
    return showAllTools || status.kind === "older" || (status.kind === "missing" && needed);
  });
  const harnesses = TOOLS.filter((tool) => tool.kind === "harness" || tool.kind === "runner");
  const level = worstLevel(machine);

  return (
    <aside className="fpa-pane" aria-label={machine.name}>
      <div className="fpa-pane-scroll">
        <div className="fpa-pane-head">
          <span className="fpa-pane-icon">
            <MachineIcon machine={machine} size={18} />
          </span>
          <div className="fpa-pane-title">
            <h2>{machine.name}</h2>
            <span>
              <StatusDot machine={machine} level={level} />
              <span className="fpa-pane-sub">
                {describeState(machine)}
                {offline ? "" : ` · ${machine.os} · ${machine.arch}`}
              </span>
            </span>
          </div>
          <button type="button" className="icon-btn" aria-label="More">
            <MoreIcon size={16} />
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        {offline && (
          <div className="fpa-banner is-fail">
            <p>
              The controller last heard from {machine.name} on {machine.lastSeen}. The values below
              are from then.
            </p>
            <span>
              Start the machine and it reconnects by itself. Or retire it: its {machine.pinned}{" "}
              threads keep their transcripts, but cannot resume.
            </span>
          </div>
        )}

        <PaneSection
          title="Sessions"
          value={offline ? "—" : `${machine.running} of ${machine.slots}`}
          aside={machine.queued > 0 ? `${machine.queued} waiting` : undefined}
        >
          <SlotPips machine={machine} size="lg" />
          {running.length > 0 && (
            <ul className="fpa-faces">
              {running.slice(0, 5).map((each, index) => (
                <li key={each.id}>
                  <Face
                    look={buildSessionLook(each.id, index % 3 === 2 ? "run" : "thread")}
                    pose={index === 1 ? "waiting" : "working"}
                    size={22}
                  />
                  <span className="fpa-face-name">{each.thread}</span>
                  <ProjectDot project={each.project} />
                  <span className="fpa-face-proj">{each.project}</span>
                </li>
              ))}
              {running.length > 5 && <li className="fpa-faces-more">{running.length - 5} more</li>}
            </ul>
          )}
        </PaneSection>

        <PaneSection
          title="Disk"
          value={`${Math.round(diskShare(machine) * 100)}%`}
          aside={`${formatGB(machine.diskFreeGB)} free of ${formatGB(machine.diskTotalGB)}`}
          level={diskLevel(machine)}
        >
          <DiskBar machine={machine} parts={parts} height={10} />
          <div className="fpa-legend">
            <LegendRow part="inUse" label="Workspaces in use" gb={parts.inUse} />
            <LegendRow
              part="idle"
              label="Idle workspaces"
              hint={`${idleWorkspaces(machine.id, fleet.workspaces).length} not used for two weeks`}
              gb={parts.idle}
              action={
                !offline && parts.idle > 1 ? (
                  <button type="button" className="link" onClick={onCleanup}>
                    Clean up…
                  </button>
                ) : undefined
              }
            />
            <LegendRow part="caches" label="Repository caches" gb={parts.caches} />
            <LegendRow
              part="providerData"
              label="Session data"
              gb={parts.providerData + parts.logs}
            />
            <LegendRow part="other" label="Not Hercule's" gb={parts.other} />
          </div>
          {days !== null && (
            <p className="fpa-note is-you">
              Fills by about {Math.round(-machine.diskTrendGBPerDay)} GB a day. At this rate, it
              reaches its {machine.diskWatermarkGB} GB limit in {days} days and stops taking
              sessions.
            </p>
          )}
        </PaneSection>

        {!offline && (
          <PaneSection
            title="Memory"
            value={`${Math.round(memoryShare(machine) * 100)}%`}
            aside={`${formatGB(machine.memoryFreeGB)} free of ${formatGB(machine.memoryTotalGB)}`}
            level={memoryLevel(machine)}
          >
            <Meter value={memoryShare(machine)} level={memoryLevel(machine)} height={6} />
            <p className="fpa-note">CPU at {machine.cpu}% over the last minute.</p>
          </PaneSection>
        )}

        <PaneSection title="Software">
          <div className="fpa-tools">
            {harnesses.map((tool) => (
              <ToolLine key={tool.id} fleet={fleet} toolId={tool.id} machine={machine} />
            ))}
          </div>
          <div className="fpa-tools fpa-tools--chains">
            <div className="fpa-tools-h">
              <span>Toolchains</span>
              <button type="button" className="link" onClick={() => setShowAllTools(!showAllTools)}>
                {showAllTools ? "Show what needs a look" : `Show all ${toolchains.length}`}
              </button>
            </div>
            {toolRows.map((tool) => (
              <ToolLine key={tool.id} fleet={fleet} toolId={tool.id} machine={machine} />
            ))}
            {toolRows.length === 0 && (
              <p className="fpa-note">
                {offline
                  ? "Not known while the machine is offline."
                  : "Every toolchain a project needs is current."}
              </p>
            )}
          </div>
        </PaneSection>

        <PaneSection title="Projects">
          <div className="fpa-projects">
            {PROJECTS.map((project) => {
              const gaps = findGaps(fleet, project.id, machine);
              const fixable = gaps.filter((gap) => gap.tool.via[machine.platform] !== null);
              return (
                <div key={project.id} className="fpa-project">
                  <ProjectDot project={project.id} />
                  <b>{project.name}</b>
                  {gaps.length === 0 ? (
                    <span className="fpa-ok">Can run here</span>
                  ) : (
                    <>
                      <span className="fpa-gap">
                        Needs{" "}
                        {gaps
                          .map(
                            (gap) =>
                              `${gap.tool.name} ${gap.need.range}${gap.has === null ? "" : ` (has ${gap.has})`}`,
                          )
                          .join(", ")}
                      </span>
                      {fixable.length > 0 && !offline && (
                        <InstallGaps
                          machine={machine}
                          toolIds={fixable.map((gap) => gap.tool.id)}
                        />
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </PaneSection>

        <PaneSection title="Machine">
          <div className="fpa-settings">
            <SettingRow label="Sessions at most" hint="How many sessions run here at once">
              <Stepper machine={machine} />
            </SettingRow>
            <SettingRow label="Labels" hint="Work can ask for a machine by its labels">
              <span className="fpa-labels">
                {machine.labels.map((label) => (
                  <span key={label} className="chip">
                    {label}
                  </span>
                ))}
                <button type="button" className="icon-btn icon-btn--sm" aria-label="Add a label">
                  <PlusIcon size={12} />
                </button>
              </span>
            </SettingRow>
            <SettingRow label="Reserved" hint="Runs only the work that names it">
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-checked={machine.reserved}
              />
            </SettingRow>
            <SettingRow
              label="Disk limit"
              hint="Below this much free space it takes no new sessions"
            >
              <span className="fpa-value">{machine.diskWatermarkGB} GB</span>
            </SettingRow>
            <SettingRow
              label="Runner"
              hint={`Hercule ${machine.runnerVersion}, controller ${CONTROLLER_VERSION}`}
            >
              <span className="fpa-value">Joined 12 Aug</span>
            </SettingRow>
          </div>
          <div className="fpa-danger">
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
                disabled={offline}
                onClick={() => setDraining(machine.id, true)}
              >
                Stop new work
              </button>
            )}
            <button type="button" className="btn btn--sm btn--danger">
              Retire…
            </button>
          </div>
        </PaneSection>
      </div>
    </aside>
  );
}

function PaneSection({
  title,
  value,
  aside,
  level = "ok",
  children,
}: {
  readonly title: string;
  readonly value?: string;
  readonly aside?: string | undefined;
  readonly level?: Level;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="fpa-psec">
      <h3>
        <span>{title}</span>
        {value !== undefined && <b className={level === "ok" ? undefined : "is-you"}>{value}</b>}
        {aside !== undefined && <small>{aside}</small>}
      </h3>
      {children}
    </section>
  );
}

function LegendRow({
  part,
  label,
  hint,
  gb,
  action,
}: {
  readonly part: string;
  readonly label: string;
  readonly hint?: string;
  readonly gb: number;
  readonly action?: ReactNode;
}): JSX.Element {
  return (
    <div className="fpa-legend-row">
      <Swatch part={part} />
      <span className="fpa-legend-label">
        {label}
        {hint !== undefined && <small>{hint}</small>}
      </span>
      {action}
      <span className="fpa-legend-gb">{formatGB(gb)}</span>
    </div>
  );
}

function ToolLine({
  fleet,
  toolId,
  machine,
}: {
  readonly fleet: FleetState;
  readonly toolId: string;
  readonly machine: Machine;
}): JSX.Element {
  const tool = TOOL_BY_ID.get(toolId)!;
  const status = readToolStatus(fleet, tool, machine);
  return (
    <div className="fpa-tool">
      <span className="fpa-tool-name">
        <ToolMark tool={tool} size={13} />
        {tool.name}
      </span>
      {status.kind === "missing" ? (
        <span className="fpa-tool-ver is-none">Not installed</span>
      ) : status.kind === "unknown" ? (
        <span className="fpa-tool-ver">{status.installed?.version ?? "—"}</span>
      ) : (
        <span className={status.kind === "older" ? "fpa-tool-ver is-older" : "fpa-tool-ver"}>
          {status.installed.version}
          {status.installed.source === "machine" && <small> machine's own</small>}
        </span>
      )}
      <span className="fpa-tool-act">
        {status.kind === "older" && (
          <ToolButton tool={tool} machines={[machine]} label={`Update to ${tool.target}`} />
        )}
        {status.kind === "missing" && (
          <ToolButton tool={tool} machines={[machine]} label="Install" quiet />
        )}
        {status.kind === "current" && <span className="fpa-current">Current</span>}
      </span>
    </div>
  );
}

function InstallGaps({
  machine,
  toolIds,
}: {
  readonly machine: Machine;
  readonly toolIds: ReadonlyArray<string>;
}): JSX.Element {
  // One button per gap would crowd the row; a project's gaps are installed together.
  const fleet = useFleet();
  const pending = toolIds.some((id) => fleet.pending.has(`tool:${id}:${machine.id}`));
  return (
    <button
      type="button"
      className="btn btn--sm"
      aria-disabled={pending || undefined}
      onClick={async () => {
        if (pending) return;
        await Promise.all(toolIds.map((id) => installTool(id, [machine.id])));
      }}
    >
      {pending ? (
        <>
          <span className="spin" /> Installing…
        </>
      ) : toolIds.length === 1 ? (
        `Install ${TOOL_BY_ID.get(toolIds[0]!)!.name}`
      ) : (
        `Install ${toolIds.length}`
      )}
    </button>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="fpa-set">
      <span className="fpa-set-label">
        <b>{label}</b>
        <span>{hint}</span>
      </span>
      {children}
    </div>
  );
}

function Stepper({ machine }: { readonly machine: Machine }): JSX.Element {
  return (
    <span className="fpa-stepper">
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
  );
}

// ---------- Software: a list of things to do ----------

function SoftwareToDo({ fleet }: { readonly fleet: FleetState }): JSX.Element {
  const online = fleet.machines.filter((each) => each.connectivity === "online");
  const updates = TOOLS.map((tool) => ({ tool, machines: machinesToUpdate(fleet, tool) })).filter(
    (each) => each.machines.length > 0,
  );
  const gaps = online.flatMap((machine) =>
    PROJECTS.map((project) => ({
      machine,
      project,
      gaps: findGaps(fleet, project.id, machine),
    })).filter((each) => each.gaps.length > 0),
  );
  const settled = TOOLS.filter(
    (tool) =>
      machinesToUpdate(fleet, tool).length === 0 &&
      !gaps.some((each) => each.gaps.some((gap) => gap.tool === tool)),
  );
  const allUpdatable = updates.flatMap((each) =>
    each.machines.map((machine) => ({ tool: each.tool, machine })),
  );
  const anyPending = allUpdatable.some(({ tool, machine }) =>
    fleet.pending.has(`tool:${tool.id}:${machine.id}`),
  );

  return (
    <div className="fpa-inner fpa-sw">
      <p className="fpa-sw-lead">
        Hercule installs the harnesses and toolchains its sessions use, and keeps every machine on
        the same versions. It installs them for its own sessions, and never changes the machine's
        own copies.
      </p>

      <section className="fpa-sec">
        <GroupHeading
          count={updates.length}
          you={updates.length > 0}
          aside={
            updates.length > 1 && (
              <button
                type="button"
                className="btn btn--sm"
                aria-disabled={anyPending || undefined}
                onClick={() => {
                  void Promise.all(
                    updates.map((each) =>
                      installTool(
                        each.tool.id,
                        each.machines.map((machine) => machine.id),
                      ),
                    ),
                  );
                }}
              >
                Update all
              </button>
            )
          }
        >
          Updates
        </GroupHeading>
        <div className="fpa-todo">
          {updates.map(({ tool, machines }) => (
            <div key={tool.id} className="fpa-todo-row">
              <span className="fpa-todo-name">
                <ToolMark tool={tool} size={14} />
                <b>{tool.name}</b>
                <span className="fpa-todo-to">{tool.target}</span>
              </span>
              <span className="fpa-todo-where">
                {machines.map((machine) => (
                  <span key={machine.id}>
                    {machine.name}{" "}
                    <span className="fp-ver is-older">
                      {fleet.installed[tool.id]?.[machine.id]?.version}
                    </span>
                  </span>
                ))}
                {tool.kind === "runner" && (
                  <small>Waits until its sessions finish, then restarts.</small>
                )}
                {tool.kind === "harness" && (
                  <small>Running sessions keep the version they started with.</small>
                )}
              </span>
              <ToolButton
                tool={tool}
                machines={machines}
                label={machines.length === 1 ? "Update" : `Update ${machines.length}`}
              />
            </div>
          ))}
          {updates.length === 0 && (
            <p className="fpa-note">Every machine runs the newest versions.</p>
          )}
        </div>
      </section>

      <section className="fpa-sec">
        <GroupHeading count={gaps.length} you={gaps.length > 0}>
          Projects that cannot run everywhere
        </GroupHeading>
        <div className="fpa-todo">
          {gaps.map(({ machine, project, gaps: missing }) => {
            const fixable = missing.filter((gap) => gap.tool.via[machine.platform] !== null);
            const byHand = missing.filter((gap) => gap.tool.via[machine.platform] === null);
            return (
              <div key={`${machine.id}-${project.id}`} className="fpa-todo-row">
                <span className="fpa-todo-name">
                  <ProjectDot project={project.id} />
                  <b>{project.name}</b>
                  <span className="fpa-todo-on">on {machine.name}</span>
                </span>
                <span className="fpa-todo-where">
                  {missing.map((gap) => (
                    <span key={gap.tool.id}>
                      {gap.tool.name} {gap.need.range}
                      <span className="faint">
                        {gap.has === null ? ", missing" : `, has ${gap.has}`} · from{" "}
                        {gap.need.source}
                      </span>
                    </span>
                  ))}
                  {byHand.length > 0 && (
                    <small>
                      {byHand.map((gap) => gap.tool.name).join(" and ")} needs installing by hand.
                    </small>
                  )}
                </span>
                {fixable.length > 0 ? (
                  <InstallGaps machine={machine} toolIds={fixable.map((gap) => gap.tool.id)} />
                ) : (
                  <span className="fp-by-hand">Install by hand</span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="fpa-sec">
        <GroupHeading>Current everywhere</GroupHeading>
        <div className="fpa-settled">
          {settled.map((tool) => {
            const on = online.filter(
              (machine) => readToolStatus(fleet, tool, machine).kind === "current",
            ).length;
            return (
              <span key={tool.id} className="fpa-settled-item">
                <ToolMark tool={tool} size={12} />
                <b>{tool.name}</b> <span className="fp-ver">{tool.target}</span>
                <small>
                  on {on} of {online.length}
                </small>
              </span>
            );
          })}
        </div>
      </section>
    </div>
  );
}
