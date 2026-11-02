/**
 * PROTOTYPE - throwaway. Variant E, "Lenses": the machine cards are the only
 * surface, and C's concerns are lenses over them. The cards keep their
 * order and their place; a lens changes what each one shows, and the cards
 * glide to their new shape. Under Software the cards stand side by side as
 * columns, so the version matrix is made of the cards themselves. A card
 * opens its machine's page at the lens's section.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { PlusIcon } from "../../icons/plus";
import {
  AddMachineDialog,
  CleanupDialog,
  DiskBar,
  MachineIcon,
  ProjectDot,
  Swatch,
} from "./fleet-atoms";
import {
  AutoCleanRow,
  CardHead,
  DayStrip,
  FleetLead,
  Ladder,
  MachineCard,
  MachinePage,
  PolicyPicker,
  ReviewDialog,
  scrollToId,
  Sparkline,
  ToolDetail,
  transition,
  VersionCell,
  zoomFloor,
} from "./fleet-blocks";
import {
  buildChanges,
  buildDiskParts,
  computeHeadroom,
  daysUntilFull,
  diskLevel,
  diskShare,
  findGaps,
  formatGB,
  isAway,
  machineById,
  memoryShare,
  PROJECTS,
  readHistory,
  setSlots,
  suggestSlots,
  TOOLS,
  toolKey,
  useFleet,
  type FleetState,
  type Machine,
  type MachineId,
  type Tool,
} from "./fleet-world";
import { ToolMark } from "./fleet-atoms";
import "./variant-e.css";

type Lens = "overview" | "capacity" | "storage" | "software";

const LENSES: ReadonlyArray<{ readonly lens: Lens; readonly label: string }> = [
  { lens: "overview", label: "Overview" },
  { lens: "capacity", label: "Capacity" },
  { lens: "storage", label: "Storage" },
  { lens: "software", label: "Software" },
];

export function VariantE(): JSX.Element {
  const fleet = useFleet();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fleetScroll = useRef(0);
  const [lens, setLens] = useState<Lens>("overview");
  const [openId, setOpenId] = useState<MachineId | null>(null);
  const [cleanupId, setCleanupId] = useState<MachineId | null>(null);
  const [review, setReview] = useState<{ readonly machineId: MachineId | undefined } | null>(null);
  const [adding, setAdding] = useState(false);

  useLayoutEffect(() => {
    if (openId === null && scrollRef.current !== null)
      scrollRef.current.scrollTop = fleetScroll.current;
  }, [openId]);

  const open = (id: MachineId | null) => {
    if (openId === null) fleetScroll.current = scrollRef.current?.scrollTop ?? 0;
    transition(
      () => setOpenId(id),
      id === null || lens === "overview"
        ? undefined
        : () => scrollToId(scrollRef, `fx-m-${lens}`, false),
    );
  };
  const pickLens = (next: Lens) => {
    if (openId !== null) {
      setLens(next);
      if (next === "overview") scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      else scrollToId(scrollRef, `fx-m-${next}`);
      return;
    }
    transition(() => setLens(next));
  };

  const online = fleet.machines.filter((each) => !isAway(each));
  const room = online.reduce((sum, each) => sum + computeHeadroom(each).room, 0);
  const idle = fleet.machines.reduce(
    (sum, each) => sum + buildDiskParts(each, fleet.workspaces).idle,
    0,
  );
  const changes = buildChanges(fleet);
  const counts: Readonly<Record<Lens, string>> = {
    overview: String(fleet.machines.length),
    capacity: `${room} free`,
    storage: `${formatGB(idle)} idle`,
    software: changes.length > 0 ? `${changes.length} to do` : "in line",
  };

  return (
    <div className="fp-page fxe">
      <div className="top">
        <nav className="pill" aria-label="Fleet">
          {openId === null ? (
            <h1 className="pill-title">Fleet</h1>
          ) : (
            <>
              <span className="fxe-crumb">
                <button type="button" onClick={() => open(null)}>
                  Fleet
                </button>
              </span>
              <span className="ptab is-name">
                <MachineIcon machine={machineById(fleet, openId)} size={14} />
                {openId}
              </span>
              <i className="fxe-rule" />
            </>
          )}
          {LENSES.map((each) => (
            <button
              key={each.lens}
              type="button"
              className={each.lens === lens ? "ptab is-on" : "ptab"}
              aria-pressed={each.lens === lens}
              onClick={() => pickLens(each.lens)}
            >
              {each.label}
              {openId === null && (
                <small
                  className={each.lens === "software" && changes.length > 0 ? "is-you" : undefined}
                >
                  {counts[each.lens]}
                </small>
              )}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {openId === null && (
          <nav className="pill">
            <button type="button" className="pill-btn" onClick={() => setAdding(true)}>
              <PlusIcon size={14} /> Add a machine
            </button>
          </nav>
        )}
      </div>
      <div ref={scrollRef} className="fp-scroll fxe-scroll" key={openId ?? "fleet"}>
        {openId === null ? (
          <div className="fxe-col">
            <LensLead
              fleet={fleet}
              lens={lens}
              onReview={() => setReview({ machineId: undefined })}
            />
            <div
              className={lens === "software" ? "fxe-grid is-columns" : "fxe-grid"}
              style={{ "--fxe-cols": fleet.machines.length } as CSSProperties}
            >
              {lens === "software" && <SoftwareLabels fleet={fleet} />}
              {fleet.machines.map((machine) =>
                lens === "overview" ? (
                  <MachineCard
                    key={machine.id}
                    fleet={fleet}
                    machine={machine}
                    onOpen={() => open(machine.id)}
                    onCleanup={() => setCleanupId(machine.id)}
                  />
                ) : (
                  <LensCard
                    key={machine.id}
                    fleet={fleet}
                    machine={machine}
                    lens={lens}
                    onOpen={() => open(machine.id)}
                    onCleanup={() => setCleanupId(machine.id)}
                  />
                ),
              )}
            </div>
            {lens === "storage" && <AutoCleanRow fleet={fleet} />}
          </div>
        ) : (
          <div className="fxe-col">
            <MachinePage
              fleet={fleet}
              machine={machineById(fleet, openId)}
              onCleanup={() => setCleanupId(openId)}
              onReview={() => setReview({ machineId: openId })}
            />
          </div>
        )}
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

/** What leads the grid under each lens: the fleet's sentence, and the lens's key. */
function LensLead({
  fleet,
  lens,
  onReview,
}: {
  readonly fleet: FleetState;
  readonly lens: Lens;
  readonly onReview: () => void;
}): JSX.Element {
  if (lens === "overview") return <FleetLead fleet={fleet} />;
  const online = fleet.machines.filter((each) => !isAway(each));
  if (lens === "capacity") {
    const room = online.reduce((sum, each) => sum + computeHeadroom(each).room, 0);
    return (
      <header className="fx-lead fxe-lead">
        <h2>Room for {room} more sessions.</h2>
        <p>
          Each block is a session slot. The rule is the cap; past it, dashed blocks are what the
          memory would hold.
        </p>
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
      </header>
    );
  }
  if (lens === "storage") {
    const idle = fleet.machines.reduce(
      (sum, each) => sum + buildDiskParts(each, fleet.workspaces).idle,
      0,
    );
    return (
      <header className="fx-lead fxe-lead">
        <h2>{formatGB(idle)} sits in idle workspaces.</h2>
        <p>Each bar is drawn to its disk's real size, against the biggest disk in the fleet.</p>
        <div className="fx-storage-legend">
          <span>
            <Swatch part="inUse" /> In use
          </span>
          <span>
            <Swatch part="idle" /> Idle
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
        </div>
      </header>
    );
  }
  const changes = buildChanges(fleet);
  const pending = changes.some((change) =>
    fleet.pending.has(toolKey(change.tool.id, change.machine.id)),
  );
  return (
    <header className="fx-lead fxe-lead">
      <h2>
        {changes.length === 0
          ? "Every machine is in line."
          : `${changes.length} installs are out of line.`}
      </h2>
      <p>
        The left column is the baseline: what Hercule keeps every machine at. It installs for its
        own sessions with mise, next to the machine's own copies.
      </p>
      {changes.length > 0 && (
        <div className="fx-baseline is-due">
          <span>
            <b>{changes.length} changes</b> on{" "}
            {new Set(changes.map((change) => change.machine.id)).size} machines. Running sessions
            keep what they started with.
          </span>
          <button
            type="button"
            className="btn btn--sm btn--accent"
            aria-disabled={pending || undefined}
            onClick={onReview}
          >
            {pending ? (
              <>
                <span className="spin" /> Applying…
              </>
            ) : (
              "Review and apply…"
            )}
          </button>
        </div>
      )}
    </header>
  );
}

function LensCard({
  fleet,
  machine,
  lens,
  onOpen,
  onCleanup,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly lens: Exclude<Lens, "overview">;
  readonly onOpen: () => void;
  readonly onCleanup: () => void;
}): JSX.Element {
  const away = isAway(machine);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`fx-card fxe-card is-${lens}${away ? " is-away" : ""}`}
      style={{ viewTransitionName: `fx-card-${machine.id}` } as CSSProperties}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      <CardHead machine={machine} />
      {lens === "capacity" && <CapacityBody fleet={fleet} machine={machine} />}
      {lens === "storage" && <StorageBody fleet={fleet} machine={machine} onCleanup={onCleanup} />}
      {lens === "software" && <SoftwareBody fleet={fleet} machine={machine} />}
    </div>
  );
}

function CapacityBody({
  fleet,
  machine,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
}): JSX.Element {
  const away = isAway(machine);
  const headroom = computeHeadroom(machine);
  const pending = fleet.pending.has(`slots:${machine.id}`);
  return (
    <div className="fxe-body">
      <div className="fxe-big">
        <b className={machine.queued > 0 ? "is-you" : undefined}>
          {away ? "—" : machine.running}
          {!away && <small> of {machine.slots}</small>}
        </b>
        <span>
          {away
            ? `Away since ${machine.lastSeen}`
            : headroom.room === 0
              ? machine.queued > 0
                ? `${machine.queued} waiting`
                : "Full"
              : `${headroom.room} free`}
        </span>
      </div>
      <Ladder machine={machine} />
      <div className="fxe-day">
        <DayStrip machine={machine} tall />
        <span>
          <span>Yesterday 10:00</span>
          <span>Now</span>
        </span>
      </div>
      <div className="fxe-foot">
        <span className="fxe-facts">
          {away ? (
            "—"
          ) : (
            <>
              Memory {Math.round(memoryShare(machine) * 100)}% · CPU {machine.cpu}%
            </>
          )}
        </span>
        {!away && machine.queued > 0 && (
          <button
            type="button"
            className="btn btn--sm"
            aria-disabled={pending || undefined}
            onClick={(event) => {
              event.stopPropagation();
              void setSlots(machine.id, suggestSlots(machine));
            }}
          >
            {pending ? (
              <>
                <span className="spin" /> Saving…
              </>
            ) : (
              `Allow ${suggestSlots(machine)}`
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function StorageBody({
  fleet,
  machine,
  onCleanup,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly onCleanup: () => void;
}): JSX.Element {
  const away = isAway(machine);
  const parts = buildDiskParts(machine, fleet.workspaces);
  const days = daysUntilFull(machine);
  const level = away ? "ok" : diskLevel(machine);
  const scale = Math.max(...fleet.machines.map((each) => each.diskTotalGB));
  const used = readHistory(machine).diskFree.map((free) => machine.diskTotalGB - free);
  const ceiling = machine.diskTotalGB - machine.diskWatermarkGB;
  return (
    <div className="fxe-body">
      <div className="fxe-big">
        <b className={level === "ok" ? undefined : "is-you"}>
          {Math.round(diskShare(machine) * 100)}
          <small>%</small>
        </b>
        <span>
          {formatGB(machine.diskFreeGB)} free of {formatGB(machine.diskTotalGB)}
        </span>
      </div>
      <div className="fxe-disk" style={{ width: `${(machine.diskTotalGB / scale) * 100}%` }}>
        <DiskBar machine={machine} parts={parts} height={12} />
      </div>
      <dl className="fxe-parts">
        <div>
          <dt>
            <Swatch part="inUse" /> In use
          </dt>
          <dd>{formatGB(parts.inUse)}</dd>
        </div>
        <div className={level === "ok" ? undefined : "is-you"}>
          <dt>
            <Swatch part="idle" /> Idle
          </dt>
          <dd>{formatGB(parts.idle)}</dd>
        </div>
        <div>
          <dt>
            <Swatch part="caches" /> Caches
          </dt>
          <dd>{formatGB(parts.caches)}</dd>
        </div>
        <div>
          <dt>
            <Swatch part="other" /> Not Hercule's
          </dt>
          <dd>{formatGB(parts.other)}</dd>
        </div>
      </dl>
      <div className="fxe-trend">
        <Sparkline
          values={used}
          max={ceiling}
          min={zoomFloor(used, ceiling)}
          ceiling={ceiling}
          forecast={days === null || away ? 0 : Math.min(days, 14)}
          tone={level === "ok" ? "ink" : "you"}
          height={30}
        />
      </div>
      <div className="fxe-foot">
        <span className={days !== null && !away ? "fxe-facts is-you" : "fxe-facts"}>
          {away
            ? `As of ${machine.lastSeen}`
            : days !== null
              ? `Limit in ${days} days`
              : machine.diskTrendGBPerDay <= -1
                ? `Grows ${Math.round(-machine.diskTrendGBPerDay)} GB a day`
                : "Steady over 14 days"}
        </span>
        {!away && parts.idle >= 3 && (
          <button
            type="button"
            className={level === "ok" ? "btn btn--sm btn--quiet" : "btn btn--sm"}
            onClick={(event) => {
              event.stopPropagation();
              onCleanup();
            }}
          >
            Clean up…
          </button>
        )}
      </div>
    </div>
  );
}

const SOFTWARE_GROUPS: ReadonlyArray<{
  readonly title: string;
  readonly tools: ReadonlyArray<Tool>;
}> = [
  { title: "Harnesses", tools: TOOLS.filter((tool) => tool.kind !== "toolchain") },
  { title: "Toolchains", tools: TOOLS.filter((tool) => tool.kind === "toolchain") },
];

/** The column at the left under Software: the baseline, one row per tool, lined up with the cards' rows. */
function SoftwareLabels({ fleet }: { readonly fleet: FleetState }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  // A click anywhere else closes the open tool's details.
  useEffect(() => {
    if (open === null) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".fxe-label-pop, .fxe-label-name")) setOpen(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="fxe-labels">
      <div className="fxe-labels-head">Keep at</div>
      {SOFTWARE_GROUPS.map((group) => (
        <div key={group.title} className="fxe-group">
          <div className="fxe-group-h">{group.title}</div>
          {group.tools.map((tool) => (
            <div key={tool.id} className="fxe-row fxe-label" title={tool.blurb}>
              <button
                type="button"
                className="fxe-label-name"
                onClick={() => setOpen(open === tool.id ? null : tool.id)}
              >
                <ToolMark tool={tool} size={13} />
                <b>{tool.name}</b>
              </button>
              <PolicyPicker tool={tool} policy={fleet.policies[tool.id]!} />
              {open === tool.id && (
                <div className="fxe-label-pop" onClick={(event) => event.stopPropagation()}>
                  <ToolDetail fleet={fleet} tool={tool} />
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
      <div className="fxe-group">
        <div className="fxe-group-h">Can it run?</div>
        {PROJECTS.map((project) => (
          <div key={project.id} className="fxe-row fxe-label">
            <span className="fxe-label-name">
              <ProjectDot project={project.id} />
              <b>{project.name}</b>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SoftwareBody({
  fleet,
  machine,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
}): JSX.Element {
  return (
    <div className="fxe-body">
      {SOFTWARE_GROUPS.map((group) => (
        <div key={group.title} className="fxe-group">
          <div className="fxe-group-h" />
          {group.tools.map((tool) => (
            <div key={tool.id} className="fxe-row">
              <VersionCell
                fleet={fleet}
                tool={tool}
                machine={machine}
                policy={fleet.policies[tool.id]!}
              />
            </div>
          ))}
        </div>
      ))}
      <div className="fxe-group">
        <div className="fxe-group-h" />
        {PROJECTS.map((project) => {
          const gaps = isAway(machine) ? null : findGaps(fleet, project.id, machine);
          return (
            <div key={project.id} className="fxe-row">
              {gaps === null ? (
                <span className="fx-cell is-unknown">?</span>
              ) : gaps.length === 0 ? (
                <span className="fx-cell is-yes">Yes</span>
              ) : (
                <span
                  className="fx-cell is-no"
                  title={gaps.map((gap) => `${gap.tool.name} ${gap.need.range}`).join(", ")}
                >
                  Needs {gaps.length}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
