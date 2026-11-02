/**
 * PROTOTYPE - throwaway. Variant G, "Grid or list, then software": the
 * Fleet page shows the machines as a grid of cards or as a list, with a
 * toggle on the Machines heading, and the software matrix under them, tools
 * down and machines across. Everything else about a machine is on its own
 * page, which a card, a row, or a machine's name over the matrix opens.
 * Switching between grid and list glides each card into its row.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { IconFrame, type IconProps } from "../../icons/icon-frame";
import { ListIcon } from "../../icons/list";
import { PlusIcon } from "../../icons/plus";
import {
  AddMachineDialog,
  CleanupDialog,
  MachineIcon,
  Meter,
  SlotPips,
  StatusDot,
} from "./fleet-atoms";
import {
  ActivityView,
  AttentionLine,
  FleetLead,
  MachineCard,
  MachinePage,
  ReviewDialog,
  scrollToId,
  SoftwarePanel,
  transition,
  useScrollSpy,
  worstLevel,
  type Concern,
} from "./fleet-blocks";
import {
  buildChanges,
  computeHeadroom,
  daysUntilFull,
  diskLevel,
  diskShare,
  findIssues,
  formatGB,
  isAway,
  machineById,
  memoryLevel,
  memoryShare,
  useFleet,
  type FleetState,
  type Machine,
  type MachineId,
} from "./fleet-world";
import "./variant-g.css";

type View = "grid" | "list";

const FLEET_PARTS = ["fx-machines", "fx-software"] as const;
const MACHINE_PARTS = [
  "fx-m-capacity",
  "fx-m-work",
  "fx-m-storage",
  "fx-m-software",
  "fx-m-activity",
] as const;

/** Reads the view from the address, so a reload keeps it. */
const readView = (): View =>
  new URLSearchParams(location.search).get("view") === "list" ? "list" : "grid";

const writeView = (view: View): void => {
  const search = new URLSearchParams(location.search);
  search.set("view", view);
  history.replaceState(null, "", `${location.pathname}?${search.toString()}`);
};

/** Renders the grid icon: four rounded squares. */
function GridIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1.2" />
    </IconFrame>
  );
}

export function VariantG(): JSX.Element {
  const fleet = useFleet();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fleetScroll = useRef(0);
  const [view, setView] = useState<View>(readView);
  const [openId, setOpenId] = useState<MachineId | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [cleanupId, setCleanupId] = useState<MachineId | null>(null);
  const [review, setReview] = useState<{ readonly machineId: MachineId | undefined } | null>(null);
  const [adding, setAdding] = useState(false);
  const fleetPart = useScrollSpy(scrollRef, FLEET_PARTS, openId === null ? "fleet" : "machine");
  const machinePart = useScrollSpy(
    scrollRef,
    MACHINE_PARTS,
    `${openId ?? "fleet"}-${showActivity}`,
  );

  // The fleet page comes back where the user left it.
  useLayoutEffect(() => {
    if (openId === null && scrollRef.current !== null)
      scrollRef.current.scrollTop = fleetScroll.current;
  }, [openId]);

  const open = (id: MachineId | null, section?: string) => {
    if (openId === null) fleetScroll.current = scrollRef.current?.scrollTop ?? 0;
    transition(
      () => {
        setOpenId(id);
        setShowActivity(false);
      },
      section === undefined ? undefined : () => scrollToId(scrollRef, section, false),
    );
  };
  const pickView = (next: View) => {
    if (next === view) return;
    writeView(next);
    transition(() => setView(next));
  };

  const changes = buildChanges(fleet).length;
  const needy = new Set(findIssues(fleet).map((issue) => issue.machineId)).size;

  return (
    <div className="fp-page fxg">
      <div className="top">
        <nav className="pill" aria-label="Fleet">
          {openId === null ? (
            <>
              <h1 className="pill-title">Fleet</h1>
              <button
                type="button"
                className={fleetPart === "fx-machines" ? "ptab is-on" : "ptab"}
                onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
              >
                Machines{" "}
                <small className={needy > 0 ? "is-you" : undefined}>
                  {needy > 0 ? `${needy} need you` : fleet.machines.length}
                </small>
              </button>
              <button
                type="button"
                className={fleetPart === "fx-software" ? "ptab is-on" : "ptab"}
                onClick={() => scrollToId(scrollRef, "fx-software")}
              >
                Software{" "}
                <small className={changes > 0 ? "is-you" : undefined}>
                  {changes > 0
                    ? `${changes} ${changes === 1 ? "update" : "updates"}`
                    : "up to date"}
                </small>
              </button>
            </>
          ) : (
            <>
              <span className="fxg-crumb">
                <button type="button" onClick={() => open(null)}>
                  Fleet
                </button>
              </span>
              {showActivity ? (
                <>
                  <span className="fxg-crumb">
                    <button type="button" onClick={() => setShowActivity(false)}>
                      <MachineIcon machine={machineById(fleet, openId)} size={14} />
                      {openId}
                    </button>
                  </span>
                  <span className="ptab is-name">Activity</span>
                </>
              ) : (
                <>
                  <span className="ptab is-name">
                    <MachineIcon machine={machineById(fleet, openId)} size={14} />
                    {openId}
                  </span>
                  <i className="fxg-rule" />
                  {(
                    [
                      ["fx-m-capacity", "Capacity"],
                      ["fx-m-work", "Running"],
                      ["fx-m-storage", "Storage"],
                      ["fx-m-software", "Software"],
                      ["fx-m-activity", "Recent"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={machinePart === id ? "ptab is-on" : "ptab"}
                      onClick={() => scrollToId(scrollRef, id)}
                    >
                      {label}
                    </button>
                  ))}
                </>
              )}
            </>
          )}
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
      <div
        ref={scrollRef}
        className="fp-scroll fxg-scroll"
        key={openId === null ? "fleet" : `${openId}${showActivity ? "-activity" : ""}`}
      >
        {openId === null ? (
          <div className="fxg-col">
            <section id="fx-machines" className="fxg-machines">
              <FleetLead fleet={fleet} />
              <div className="fxg-sec-h">
                <h2>
                  Machines <span className="count">{fleet.machines.length}</span>
                </h2>
                <span className="seg fxg-view" role="group" aria-label="Show the machines as">
                  <button
                    type="button"
                    aria-pressed={view === "grid"}
                    onClick={() => pickView("grid")}
                  >
                    <GridIcon size={14} /> Grid
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === "list"}
                    onClick={() => pickView("list")}
                  >
                    <ListIcon size={14} /> List
                  </button>
                </span>
              </div>
              {view === "grid" ? (
                <div className="fxg-grid">
                  {fleet.machines.map((machine) => (
                    <MachineCard
                      key={machine.id}
                      fleet={fleet}
                      machine={machine}
                      onOpen={() => open(machine.id)}
                      onCleanup={() => setCleanupId(machine.id)}
                      onGauge={(concern: Concern) => open(machine.id, `fx-m-${concern}`)}
                    />
                  ))}
                </div>
              ) : (
                <MachineList fleet={fleet} onOpen={open} onCleanup={setCleanupId} />
              )}
            </section>
            <SoftwarePanel
              fleet={fleet}
              onReview={(machineId) => setReview({ machineId })}
              onOpenMachine={(id) => open(id, "fx-m-software")}
            />
          </div>
        ) : (
          <div className="fxg-col">
            {showActivity ? (
              <ActivityView fleet={fleet} machine={machineById(fleet, openId)} />
            ) : (
              <MachinePage
                fleet={fleet}
                machine={machineById(fleet, openId)}
                onCleanup={() => setCleanupId(openId)}
                onReview={() => setReview({ machineId: openId })}
                onShowActivity={() => setShowActivity(true)}
              />
            )}
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

// ---------- The list ----------

/**
 * The machines as rows whose columns line up, so the fleet compares at a
 * glance: sessions, the room left, disk and memory, and the one thing that
 * needs you with its fix.
 */
function MachineList({
  fleet,
  onOpen,
  onCleanup,
}: {
  readonly fleet: FleetState;
  readonly onOpen: (id: MachineId, section?: string) => void;
  readonly onCleanup: (id: MachineId) => void;
}): JSX.Element {
  return (
    <div className="fxg-list" role="table" aria-label="Machines">
      <div className="fxg-heads" role="row">
        <span />
        <span>Machine</span>
        <span>Sessions</span>
        <span className="fxg-col-room">Room</span>
        <span>Disk</span>
        <span className="fxg-col-mem">Memory</span>
        <span>Needs you</span>
        <span />
      </div>
      {fleet.machines.map((machine) => (
        <MachineRow
          key={machine.id}
          fleet={fleet}
          machine={machine}
          onOpen={(section) => onOpen(machine.id, section)}
          onCleanup={() => onCleanup(machine.id)}
        />
      ))}
    </div>
  );
}

function MachineRow({
  fleet,
  machine,
  onOpen,
  onCleanup,
}: {
  readonly fleet: FleetState;
  readonly machine: Machine;
  readonly onOpen: (section?: string) => void;
  readonly onCleanup: () => void;
}): JSX.Element {
  const away = isAway(machine);
  const disk = away ? "ok" : diskLevel(machine);
  const memory = memoryLevel(machine);
  const headroom = computeHeadroom(machine);
  const days = daysUntilFull(machine);
  return (
    <div
      role="row"
      tabIndex={0}
      className={away ? "fxg-row is-away" : "fxg-row"}
      style={{ viewTransitionName: `fx-card-${machine.id}` } as CSSProperties}
      onClick={() => onOpen()}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      <StatusDot
        machine={machine}
        level={worstLevel(machine) === "crit" && !away ? "crit" : worstLevel(machine)}
      />
      <span className="fxg-name">
        <span
          className="fxg-icon"
          style={{ viewTransitionName: `fx-icon-${machine.id}` } as CSSProperties}
        >
          <MachineIcon machine={machine} size={14} />
        </span>
        <span className="fxg-name-text">
          <b style={{ viewTransitionName: `fx-name-${machine.id}` } as CSSProperties}>
            {machine.name}
          </b>
          <small>
            {machine.isLocal ? "This Mac · " : ""}
            {machine.model}
          </small>
        </span>
      </span>
      <span className="fxg-cell">
        <SlotPips machine={machine} />
        <small className={machine.queued > 0 ? "is-you" : undefined}>
          {away ? "Away" : `${machine.running} of ${machine.slots}`}
          {machine.queued > 0 && ` · ${machine.queued} waiting`}
        </small>
      </span>
      <span className="fxg-cell fxg-col-room">
        <b className={headroom.room === 0 && !away ? "is-you" : undefined}>
          {away ? "—" : headroom.room === 0 ? "None" : `${headroom.room} more`}
        </b>
        <small className={!away && headroom.limit === "memory" ? "is-you" : undefined}>
          {away ? "" : `Limit: ${headroom.limit === "slots" ? "cap" : headroom.limit}`}
        </small>
      </span>
      <span className="fxg-cell">
        <span className="fxg-meter" data-needs="disk total">
          <Meter value={diskShare(machine)} level={disk} width={64} />
          <b className={disk === "ok" ? undefined : "is-you"}>
            {Math.round(diskShare(machine) * 100)}%
          </b>
        </span>
        <small
          className={days !== null && !away ? "is-you" : undefined}
          data-needs={days !== null && !away ? "history" : undefined}
        >
          {days !== null && !away
            ? `Limit in ${days} days`
            : `${formatGB(machine.diskFreeGB)} free`}
        </small>
      </span>
      <span className="fxg-cell fxg-col-mem">
        <span className="fxg-meter">
          <Meter value={away ? 0 : memoryShare(machine)} level={memory} width={56} />
          <b>{away ? "—" : `${Math.round(memoryShare(machine) * 100)}%`}</b>
        </span>
        <small>{away ? "" : `${formatGB(machine.memoryFreeGB)} free`}</small>
      </span>
      <span className="fxg-attn">
        <AttentionLine fleet={fleet} machine={machine} onCleanup={onCleanup} compact />
      </span>
      <ChevronRightIcon size={14} />
    </div>
  );
}
