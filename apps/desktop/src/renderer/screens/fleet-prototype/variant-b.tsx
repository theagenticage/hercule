/**
 * PROTOTYPE - throwaway. Variant B, "Rooms": a tile per machine, in a fixed
 * order, each showing its three gauges and the one thing that needs you.
 * A tile opens the machine's own page; a harness or a toolchain opens a page
 * of its own too. Everything is a place you open, as a thread is.
 */
import { useState, type JSX, type ReactNode } from "react";
import { Face } from "../../faces";
import { buildSessionLook } from "../../faces/look";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { ExternalIcon } from "../../icons/external";
import { MoreIcon } from "../../icons/more";
import { PlusIcon } from "../../icons/plus";
import {
  AddMachineDialog,
  CleanupDialog,
  DiskBar,
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
  buildDiskParts,
  daysUntilFull,
  diskLevel,
  diskShare,
  findGaps,
  findIssues,
  formatDays,
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
  type Level,
  type Machine,
  type MachineId,
  type Tool,
} from "./fleet-world";
import "../settings/settings.css";
import "../session/floating-header.css";
import "./variant-b.css";

type Place =
  | { readonly kind: "fleet" }
  | { readonly kind: "machine"; readonly id: MachineId }
  | { readonly kind: "tool"; readonly id: string };

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five"];

const worstLevel = (machine: Machine): Level => {
  const levels = [diskLevel(machine), memoryLevel(machine), slotsLevel(machine)];
  return levels.includes("crit") ? "crit" : levels.includes("warn") ? "warn" : "ok";
};

export function VariantB(): JSX.Element {
  const fleet = useFleet();
  const [place, setPlace] = useState<Place>({ kind: "fleet" });
  const [cleanupId, setCleanupId] = useState<MachineId | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="fp-page fpb">
      <div className="top">
        <nav className="pill" aria-label="Fleet">
          {place.kind === "fleet" ? (
            <h1 className="pill-title">Fleet</h1>
          ) : (
            <>
              <span className="fpb-crumb">
                <button type="button" onClick={() => setPlace({ kind: "fleet" })}>
                  Fleet
                </button>
              </span>
              <span className="ptab is-on">
                {place.kind === "machine" ? (
                  <>
                    <MachineIcon machine={machineById(fleet, place.id)} size={14} />
                    {place.id}
                  </>
                ) : (
                  <>
                    <ToolMark tool={TOOL_BY_ID.get(place.id)!} size={13} />
                    {TOOL_BY_ID.get(place.id)!.name}
                  </>
                )}
              </span>
            </>
          )}
        </nav>
      </div>
      <div className="fp-scroll fpb-scroll" key={place.kind === "fleet" ? "fleet" : place.id}>
        {place.kind === "fleet" && (
          <Overview
            fleet={fleet}
            onOpen={setPlace}
            onCleanup={setCleanupId}
            onAdd={() => setAdding(true)}
          />
        )}
        {place.kind === "machine" && (
          <MachinePage
            fleet={fleet}
            machine={machineById(fleet, place.id)}
            onCleanup={() => setCleanupId(place.id)}
            onOpenTool={(id) => setPlace({ kind: "tool", id })}
          />
        )}
        {place.kind === "tool" && (
          <ToolPage
            fleet={fleet}
            tool={TOOL_BY_ID.get(place.id)!}
            onOpenMachine={(id) => setPlace({ kind: "machine", id })}
          />
        )}
      </div>
      {cleanupId !== null && (
        <CleanupDialog machineId={cleanupId} onClose={() => setCleanupId(null)} />
      )}
      {adding && <AddMachineDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

// ---------- The overview ----------

function Overview({
  fleet,
  onOpen,
  onCleanup,
  onAdd,
}: {
  readonly fleet: FleetState;
  readonly onOpen: (place: Place) => void;
  readonly onCleanup: (id: MachineId) => void;
  readonly onAdd: () => void;
}): JSX.Element {
  const issues = findIssues(fleet);
  const needy = new Set(issues.map((issue) => issue.machineId));
  const online = fleet.machines.filter((each) => each.connectivity === "online");
  const running = online.reduce((sum, each) => sum + each.running, 0);
  const offline = fleet.machines.filter((each) => each.connectivity === "offline");
  const harnesses = TOOLS.filter((tool) => tool.kind === "harness" || tool.kind === "runner");
  const toolchains = TOOLS.filter((tool) => tool.kind === "toolchain");

  return (
    <div className="fpb-col">
      <header className="fpb-lead">
        <h2>
          {needy.size === 0
            ? "Every machine is healthy."
            : `${NUMBER_WORDS[needy.size] ?? needy.size} ${needy.size === 1 ? "machine needs" : "machines need"} you.`}
        </h2>
        <p>
          {running} sessions running on {online.length} machines.
          {offline.length > 0 &&
            ` ${offline.map((each) => each.name).join(" and ")} has been offline since ${offline[0]!.lastSeen}.`}
        </p>
      </header>

      <div className="fpb-tiles">
        {fleet.machines.map((machine) => (
          <Tile
            key={machine.id}
            fleet={fleet}
            machine={machine}
            onOpen={() => onOpen({ kind: "machine", id: machine.id })}
            onCleanup={() => onCleanup(machine.id)}
          />
        ))}
        <button type="button" className="fpb-tile fpb-tile--add" onClick={onAdd}>
          <span className="fpb-tile-icon">
            <PlusIcon size={16} />
          </span>
          <b>Add a machine</b>
          <span>Run one command on it, and it joins the fleet.</span>
        </button>
      </div>

      <section className="fpb-sec">
        <div className="fpb-sec-h">
          <h3>Harnesses</h3>
          <p>
            The programs that run the models. Every machine gets the newest version this Hercule
            supports.
          </p>
        </div>
        <div className="fpb-list">
          {harnesses.map((tool) => (
            <ToolRow
              key={tool.id}
              fleet={fleet}
              tool={tool}
              onOpen={() => onOpen({ kind: "tool", id: tool.id })}
            />
          ))}
        </div>
      </section>

      <section className="fpb-sec">
        <div className="fpb-sec-h">
          <h3>Toolchains</h3>
          <p>
            What your projects build with. Hercule reads what each project needs from its
            repository, and installs it for its sessions with mise.
          </p>
        </div>
        <div className="fpb-list">
          {toolchains.map((tool) => (
            <ToolRow
              key={tool.id}
              fleet={fleet}
              tool={tool}
              onOpen={() => onOpen({ kind: "tool", id: tool.id })}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function Tile({
  fleet,
  machine,
  onOpen,
  onCleanup,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly onOpen: () => void;
  readonly onCleanup: () => void;
}): JSX.Element {
  const offline = machine.connectivity === "offline";
  const disk = diskLevel(machine);
  const memory = memoryLevel(machine);
  const parts = buildDiskParts(machine, fleet.workspaces);
  const days = daysUntilFull(machine);
  const pendingSlots = fleet.pending.has(`slots:${machine.id}`);

  let foot: ReactNode;
  if (offline) {
    foot = (
      <span className="fpb-foot is-fail">{machine.pinned} threads wait for it to come back</span>
    );
  } else if (disk !== "ok") {
    foot = (
      <>
        <span className="fpb-foot is-you">
          {days !== null ? `Full in about ${days} days` : "Disk nearly full"} ·{" "}
          {formatGB(parts.idle)} idle
        </span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={(event) => {
            event.stopPropagation();
            onCleanup();
          }}
        >
          Clean up…
        </button>
      </>
    );
  } else if (machine.queued > 0) {
    const suggested = suggestSlots(machine);
    foot = (
      <>
        <span className="fpb-foot is-you">{machine.queued} threads waiting for a slot</span>
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
  } else {
    const older = TOOLS.filter(
      (tool) => readToolStatus(fleet, tool, machine).kind === "older",
    ).length;
    foot = (
      <span className="fpb-foot">
        {older > 0 ? `${older} ${older === 1 ? "update" : "updates"} available` : "Up to date"}
      </span>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`fpb-tile${offline ? " is-off" : ""}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      <div className="fpb-tile-h">
        <span className="fpb-tile-icon">
          <MachineIcon machine={machine} size={16} />
        </span>
        <span className="fpb-tile-name">
          <b>{machine.name}</b>
          <span>
            {machine.isLocal ? "This Mac · " : ""}
            {machine.model}
          </span>
        </span>
        <span className="fpb-tile-state">
          <StatusDot machine={machine} level={worstLevel(machine)} />
          {offline ? "Offline" : machine.lifecycle === "draining" ? "Draining" : "Online"}
        </span>
      </div>
      <div className="fpb-gauges">
        <Gauge
          label="Sessions"
          value={offline ? "—" : `${machine.running}`}
          unit={offline ? "" : `/${machine.slots}`}
          level={machine.queued > 0 ? "warn" : "ok"}
        >
          <SlotPips machine={machine} />
        </Gauge>
        <Gauge
          label="Disk"
          value={`${Math.round(diskShare(machine) * 100)}`}
          unit="%"
          level={offline ? "ok" : disk}
        >
          <Meter value={diskShare(machine)} level={offline ? "ok" : disk} />
        </Gauge>
        <Gauge
          label="Memory"
          value={offline ? "—" : `${Math.round(memoryShare(machine) * 100)}`}
          unit={offline ? "" : "%"}
          level={memory}
        >
          <Meter value={offline ? 0 : memoryShare(machine)} level={memory} />
        </Gauge>
      </div>
      <div className="fpb-tile-foot">{foot}</div>
    </div>
  );
}

function Gauge({
  label,
  value,
  unit,
  level,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly level: Level;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={`fpb-gauge fpb-gauge--${level}`}>
      <span className="fpb-gauge-label">{label}</span>
      <b>
        {value}
        <small>{unit}</small>
      </b>
      {children}
    </div>
  );
}

function ToolRow({
  fleet,
  tool,
  onOpen,
}: {
  readonly fleet: FleetState;
  readonly tool: Tool;
  readonly onOpen: () => void;
}): JSX.Element {
  const online = fleet.machines.filter((each) => each.connectivity === "online");
  const toUpdate = machinesToUpdate(fleet, tool);
  const current = online.filter(
    (machine) => readToolStatus(fleet, tool, machine).kind === "current",
  );
  const blocked = online.flatMap((machine) =>
    tool.needs
      .filter((need) => {
        const installed = fleet.installed[tool.id]?.[machine.id];
        return installed === undefined || !installed.version.startsWith(`${need.range}.`);
      })
      .map((need) => ({ machine, need })),
  );
  return (
    <div role="button" tabIndex={0} className="fpb-tool" onClick={onOpen}>
      <span className="fpb-tool-name">
        <ToolMark tool={tool} size={15} />
        <b>{tool.name}</b>
        <span className="fp-ver">{tool.target}</span>
      </span>
      <span className="fpb-tool-spread" aria-hidden="true">
        {fleet.machines.map((machine) => {
          const status = readToolStatus(fleet, tool, machine);
          return (
            <i
              key={machine.id}
              className={`is-${status.kind}`}
              title={`${machine.name}: ${status.kind}`}
            />
          );
        })}
      </span>
      <span className="fpb-tool-state">
        {blocked.length > 0 ? (
          <span className="is-fail">
            {[...new Set(blocked.map((each) => each.need.project))].join(", ")} cannot run on{" "}
            {[...new Set(blocked.map((each) => each.machine.name))].join(", ")}
          </span>
        ) : toUpdate.length > 0 ? (
          <span className="is-you">
            {toUpdate.length === 1
              ? `${toUpdate[0]!.name} is behind`
              : `${toUpdate.length} machines are behind`}
          </span>
        ) : (
          <span>
            On {current.length} of {online.length} machines
          </span>
        )}
      </span>
      <span className="fpb-tool-act">
        {toUpdate.length > 0 && (
          <ToolButton
            tool={tool}
            machines={toUpdate}
            label={toUpdate.length === 1 ? "Update" : `Update ${toUpdate.length}`}
          />
        )}
      </span>
      <ChevronRightIcon size={14} />
    </div>
  );
}

// ---------- A machine's page ----------

function MachinePage({
  fleet,
  machine,
  onCleanup,
  onOpenTool,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly onCleanup: () => void;
  readonly onOpenTool: (id: string) => void;
}): JSX.Element {
  const offline = machine.connectivity === "offline";
  const parts = buildDiskParts(machine, fleet.workspaces);
  const days = daysUntilFull(machine);
  const disk = diskLevel(machine);
  const running = fleet.workspaces.filter((each) => each.machineId === machine.id && each.inUse);
  const idle = idleWorkspaces(machine.id, fleet.workspaces).toSorted((a, b) => b.sizeGB - a.sizeGB);
  const pendingSlots = fleet.pending.has(`slots:${machine.id}`);

  return (
    <div className="fpb-col fpb-col--page">
      <header className="fpb-hero">
        <span className="fpb-hero-icon">
          <MachineIcon machine={machine} size={22} />
        </span>
        <div className="fpb-hero-text">
          <h2>{machine.name}</h2>
          <p>
            <StatusDot machine={machine} level={worstLevel(machine)} /> {describeState(machine)} ·{" "}
            {machine.model} · {machine.os} · {machine.arch}
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
            disabled={offline}
            onClick={() => setDraining(machine.id, true)}
          >
            Stop new work
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="More">
          <MoreIcon size={16} />
        </button>
      </header>

      {offline && (
        <div className="fpb-banner is-fail">
          <div>
            <p>Offline since {machine.lastSeen}. What you see is from then.</p>
            <span>
              Start the machine and it reconnects by itself. {machine.pinned} threads started there
              wait for it, and resume when it is back.
            </span>
          </div>
          <button type="button" className="btn btn--sm btn--danger">
            Retire…
          </button>
        </div>
      )}
      {!offline && disk !== "ok" && (
        <div className="fpb-banner">
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
      {!offline && machine.queued > 0 && (
        <div className="fpb-banner">
          <div>
            <p>
              All {machine.slots} sessions are in use, and {machine.queued} threads are waiting.
            </p>
            <span>
              They resume here, where they started. {formatGB(machine.memoryFreeGB)} of memory is
              free, enough for {suggestSlots(machine) - machine.slots} more.
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

      <div className="fpb-instruments">
        <Instrument
          label="Sessions"
          value={offline ? "—" : `${machine.running} of ${machine.slots}`}
          note={
            offline
              ? ""
              : machine.queued > 0
                ? `${machine.queued} waiting`
                : `${machine.slots - machine.running} free`
          }
          level={machine.queued > 0 ? "warn" : "ok"}
        >
          <SlotPips machine={machine} size="lg" />
        </Instrument>
        <Instrument
          label="Disk"
          value={`${Math.round(diskShare(machine) * 100)}%`}
          note={`${formatGB(machine.diskFreeGB)} free of ${formatGB(machine.diskTotalGB)}`}
          level={offline ? "ok" : disk}
        >
          <Meter value={diskShare(machine)} level={offline ? "ok" : disk} height={8} />
        </Instrument>
        <Instrument
          label="Memory"
          value={offline ? "—" : `${Math.round(memoryShare(machine) * 100)}%`}
          note={
            offline
              ? ""
              : `${formatGB(machine.memoryFreeGB)} free of ${formatGB(machine.memoryTotalGB)} · CPU ${machine.cpu}%`
          }
          level={memoryLevel(machine)}
        >
          <Meter
            value={offline ? 0 : memoryShare(machine)}
            level={memoryLevel(machine)}
            height={8}
          />
        </Instrument>
      </div>

      {running.length > 0 && (
        <PageSection title="Working here" aside={`${running.length} sessions`}>
          <ul className="fpb-crew">
            {running.map((each, index) => (
              <li key={each.id}>
                <Face
                  look={buildSessionLook(each.id, index % 3 === 2 ? "run" : "thread")}
                  pose={index === 1 ? "waiting" : "working"}
                  size={28}
                />
                <span className="fpb-crew-name">
                  <b>{each.thread}</b>
                  <span>
                    <ProjectDot project={each.project} /> {each.project} · {formatGB(each.sizeGB)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </PageSection>
      )}

      <PageSection
        title="Storage"
        aside={`${formatGB(parts.used)} used of ${formatGB(machine.diskTotalGB)}`}
      >
        <DiskBar machine={machine} parts={parts} height={14} split />
        <div className="fpb-legend">
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
        {idle.length > 0 && (
          <div className="fpb-idle">
            <div className="fpb-idle-h">
              <b>Largest idle workspaces</b>
              {!offline && (
                <button type="button" className="link" onClick={onCleanup}>
                  Review all {idle.length}…
                </button>
              )}
            </div>
            {idle.slice(0, 5).map((each) => (
              <div key={each.id} className="fpb-idle-row">
                <ProjectDot project={each.project} />
                <span className="fpb-idle-name">
                  <b>{each.thread}</b>
                  <span>
                    {each.project} · {each.branch}
                  </span>
                </span>
                {each.changes > 0 && (
                  <span className="chip chip--you">
                    {each.changes} {each.changes === 1 ? "file" : "files"} changed
                  </span>
                )}
                <span className="fpb-idle-age">{formatDays(each.lastUsedDays)}</span>
                <span className="fpb-idle-gb">{formatGB(each.sizeGB)}</span>
              </div>
            ))}
          </div>
        )}
      </PageSection>

      <PageSection title="Software">
        <div className="fpb-sw">
          {TOOLS.map((tool) => {
            const status = readToolStatus(fleet, tool, machine);
            const needed = tool.needs.length > 0;
            if (status.kind === "missing" && !needed && tool.kind === "toolchain") return null;
            return (
              <div
                key={tool.id}
                role="button"
                tabIndex={0}
                className="fpb-sw-row"
                onClick={() => onOpenTool(tool.id)}
              >
                <span className="fpb-sw-name">
                  <ToolMark tool={tool} size={13} />
                  {tool.name}
                </span>
                <span className="fpb-sw-ver">
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
                <span className="fpb-sw-src">
                  {status.kind === "current" || status.kind === "older"
                    ? status.installed.source === "hercule"
                      ? "Installed by Hercule"
                      : "The machine's own"
                    : ""}
                </span>
                <span className="fpb-sw-act">
                  {status.kind === "older" && (
                    <ToolButton
                      tool={tool}
                      machines={[machine]}
                      label={`Update to ${tool.target}`}
                    />
                  )}
                  {status.kind === "missing" && (
                    <ToolButton tool={tool} machines={[machine]} label="Install" />
                  )}
                </span>
              </div>
            );
          })}
        </div>
        <div className="fpb-readiness">
          {PROJECTS.map((project) => {
            const gaps = findGaps(fleet, project.id, machine);
            return (
              <span
                key={project.id}
                className={gaps.length === 0 ? "fpb-ready" : "fpb-ready is-gap"}
              >
                <ProjectDot project={project.id} />
                <b>{project.name}</b>
                {gaps.length === 0
                  ? "can run here"
                  : `needs ${gaps.map((gap) => `${gap.tool.name} ${gap.need.range}`).join(", ")}`}
              </span>
            );
          })}
        </div>
      </PageSection>

      <PageSection title="Settings">
        <div className="set-row">
          <div className="set-label">
            <b>Sessions at most</b>
            <span>How many sessions run here at once. Each takes about 2 GB of memory.</span>
          </div>
          <span className="fpb-stepper">
            <button
              type="button"
              onClick={() => void setSlots(machine.id, Math.max(1, machine.slots - 1))}
            >
              −
            </button>
            <b>{machine.slots}</b>
            <button type="button" onClick={() => void setSlots(machine.id, machine.slots + 1)}>
              +
            </button>
          </span>
        </div>
        <div className="set-row">
          <div className="set-label">
            <b>Labels</b>
            <span>Work can ask for a machine by its labels.</span>
          </div>
          <span className="fpb-labels">
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
            <span>Below this much free space, the machine takes no new sessions.</span>
          </div>
          <span className="fpb-value">{machine.diskWatermarkGB} GB</span>
        </div>
        <div className="set-row">
          <div className="set-label">
            <b>Retire this machine</b>
            <span>Forgets the machine. Its threads keep their transcripts, but cannot resume.</span>
          </div>
          <button type="button" className="btn btn--danger">
            Retire…
          </button>
        </div>
      </PageSection>
    </div>
  );
}

function Instrument({
  label,
  value,
  note,
  level,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly level: Level;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={`fpb-inst fpb-gauge--${level}`}>
      <span className="fpb-gauge-label">{label}</span>
      <b>{value}</b>
      {children}
      <span className="fpb-inst-note">{note}</span>
    </div>
  );
}

function PageSection({
  title,
  aside,
  children,
}: {
  readonly title: string;
  readonly aside?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="fpb-psec">
      <h3>
        {title}
        {aside !== undefined && <small>{aside}</small>}
      </h3>
      {children}
    </section>
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
    <span className="fpb-legend-item">
      <Swatch part={part} />
      <span>{label}</span>
      <b>{formatGB(gb)}</b>
    </span>
  );
}

// ---------- A tool's page ----------

function ToolPage({
  fleet,
  tool,
  onOpenMachine,
}: {
  readonly fleet: FleetState;
  readonly tool: Tool;
  readonly onOpenMachine: (id: MachineId) => void;
}): JSX.Element {
  const toUpdate = machinesToUpdate(fleet, tool);
  const missingNeeded = fleet.machines.filter(
    (machine) => readToolStatus(fleet, tool, machine).kind === "missing" && tool.needs.length > 0,
  );
  const pending = [...toUpdate, ...missingNeeded].some((machine) =>
    fleet.pending.has(`tool:${tool.id}:${machine.id}`),
  );
  return (
    <div className="fpb-col fpb-col--page">
      <header className="fpb-hero">
        <span className="fpb-hero-icon">
          {tool.kind === "harness" ? (
            <ToolMark tool={tool} size={22} />
          ) : (
            <span className="fpb-hero-glyph">{tool.name.slice(0, 2)}</span>
          )}
        </span>
        <div className="fpb-hero-text">
          <h2>{tool.name}</h2>
          <p>
            {tool.blurb} Hercule installs {tool.target}
            {tool.via.macos !== null
              ? `, with ${tool.via.macos === tool.via.linux ? tool.via.macos : `${tool.via.macos} on macOS and ${tool.via.linux} on Linux`}`
              : ""}
            .
          </p>
        </div>
        {tool.kind === "harness" && (
          <a className="btn btn--sm btn--quiet" href="#notes">
            What's new <ExternalIcon size={13} />
          </a>
        )}
        {toUpdate.length + missingNeeded.length > 1 && (
          <button
            type="button"
            className="btn btn--sm"
            aria-disabled={pending || undefined}
            onClick={() =>
              void installTool(
                tool.id,
                [...toUpdate, ...missingNeeded]
                  .filter((machine) => tool.via[machine.platform] !== null)
                  .map((machine) => machine.id),
              )
            }
          >
            {pending ? (
              <>
                <span className="spin" /> Updating…
              </>
            ) : (
              `Update all ${toUpdate.length + missingNeeded.length}`
            )}
          </button>
        )}
      </header>

      <PageSection title="On each machine">
        <div className="fpb-per">
          {fleet.machines.map((machine) => {
            const status = readToolStatus(fleet, tool, machine);
            return (
              <div key={machine.id} className="fpb-per-row">
                <button
                  type="button"
                  className="fpb-per-name"
                  onClick={() => onOpenMachine(machine.id)}
                >
                  <MachineIcon machine={machine} size={14} />
                  <b>{machine.name}</b>
                </button>
                <span className="fpb-per-ver">
                  {status.kind === "missing" ? (
                    <span className="faint">Not installed</span>
                  ) : status.kind === "unknown" ? (
                    <span className="faint">{status.installed?.version ?? "—"} · offline</span>
                  ) : (
                    <span className={status.kind === "older" ? "fp-ver is-older" : "fp-ver"}>
                      {status.installed.version}
                    </span>
                  )}
                </span>
                <span className="fpb-per-path">
                  {status.kind === "current" || status.kind === "older"
                    ? status.installed.path
                    : ""}
                </span>
                <span className="fpb-per-act">
                  {status.kind === "older" && (
                    <ToolButton tool={tool} machines={[machine]} label="Update" />
                  )}
                  {status.kind === "missing" && (
                    <ToolButton
                      tool={tool}
                      machines={[machine]}
                      label="Install"
                      quiet={tool.needs.length === 0}
                    />
                  )}
                  {status.kind === "current" && <span className="faint">Current</span>}
                </span>
              </div>
            );
          })}
        </div>
      </PageSection>

      {tool.needs.length > 0 && (
        <PageSection title="Projects that need it">
          <div className="fpb-per">
            {tool.needs.map((need) => (
              <div key={need.project} className="fpb-per-row fpb-per-row--need">
                <span className="fpb-per-name">
                  <ProjectDot project={need.project} />
                  <b>{need.project}</b>
                </span>
                <span>
                  {tool.name} {need.range}
                </span>
                <span className="faint">from {need.source}</span>
              </div>
            ))}
          </div>
        </PageSection>
      )}
    </div>
  );
}
