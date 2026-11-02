/**
 * PROTOTYPE - throwaway. Variant D, "Cards, then concerns": B's machine
 * cards on top, for the glance, then C's three concerns across the whole
 * fleet, for comparing and acting in bulk, on one page. The header's tabs
 * follow the scroll. A card opens the machine's page, and a gauge on it
 * opens the page at that gauge's section; the page has the same tabs for
 * its own sections.
 */
import { useLayoutEffect, useRef, useState, type JSX } from "react";
import { PlusIcon } from "../../icons/plus";
import { AddMachineDialog, CleanupDialog, MachineIcon } from "./fleet-atoms";
import {
  CapacityPanel,
  FleetLead,
  MachineCard,
  MachinePage,
  ReviewDialog,
  scrollToId,
  SoftwarePanel,
  StoragePanel,
  transition,
  useScrollSpy,
  type Concern,
} from "./fleet-blocks";
import {
  buildChanges,
  buildDiskParts,
  computeHeadroom,
  formatGB,
  isAway,
  machineById,
  useFleet,
  type MachineId,
} from "./fleet-world";
import "./variant-d.css";

const FLEET_PARTS = ["fx-machines", "fx-capacity", "fx-storage", "fx-software"] as const;
const MACHINE_PARTS = ["fx-m-capacity", "fx-m-storage", "fx-m-software", "fx-m-activity"] as const;

export function VariantD(): JSX.Element {
  const fleet = useFleet();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fleetScroll = useRef(0);
  const [openId, setOpenId] = useState<MachineId | null>(null);
  const [cleanupId, setCleanupId] = useState<MachineId | null>(null);
  const [review, setReview] = useState<{ readonly machineId: MachineId | undefined } | null>(null);
  const [adding, setAdding] = useState(false);
  const fleetPart = useScrollSpy(scrollRef, FLEET_PARTS, openId === null ? "fleet" : "machine");
  const machinePart = useScrollSpy(scrollRef, MACHINE_PARTS, openId ?? "fleet");

  // The fleet page comes back where the user left it.
  useLayoutEffect(() => {
    if (openId === null && scrollRef.current !== null)
      scrollRef.current.scrollTop = fleetScroll.current;
  }, [openId]);

  const open = (id: MachineId | null, section?: string) => {
    if (openId === null) fleetScroll.current = scrollRef.current?.scrollTop ?? 0;
    transition(
      () => setOpenId(id),
      section === undefined ? undefined : () => scrollToId(scrollRef, section, false),
    );
  };

  const online = fleet.machines.filter((each) => !isAway(each));
  const room = online.reduce((sum, each) => sum + computeHeadroom(each).room, 0);
  const idle = fleet.machines.reduce(
    (sum, each) => sum + buildDiskParts(each, fleet.workspaces).idle,
    0,
  );
  const changes = buildChanges(fleet).length;

  const onGauge = (machineId: MachineId) => (concern: Concern) =>
    open(machineId, `fx-m-${concern}`);

  return (
    <div className="fp-page fxd">
      <div className="top">
        <nav className="pill" aria-label="Fleet">
          {openId === null ? (
            <>
              <h1 className="pill-title">Fleet</h1>
              <Tab
                on={fleetPart === "fx-machines"}
                onClick={() => scrollToId(scrollRef, "fx-machines")}
                label="Machines"
                count={String(fleet.machines.length)}
              />
              <Tab
                on={fleetPart === "fx-capacity"}
                onClick={() => scrollToId(scrollRef, "fx-capacity")}
                label="Capacity"
                count={`${room} free`}
              />
              <Tab
                on={fleetPart === "fx-storage"}
                onClick={() => scrollToId(scrollRef, "fx-storage")}
                label="Storage"
                count={`${formatGB(idle)} idle`}
              />
              <Tab
                on={fleetPart === "fx-software"}
                onClick={() => scrollToId(scrollRef, "fx-software")}
                label="Software"
                count={changes > 0 ? `${changes} to do` : "in line"}
                you={changes > 0}
              />
            </>
          ) : (
            <>
              <span className="fxd-crumb">
                <button type="button" onClick={() => open(null)}>
                  Fleet
                </button>
              </span>
              <span className="ptab is-name">
                <MachineIcon machine={machineById(fleet, openId)} size={14} />
                {openId}
              </span>
              <i className="fxd-rule" />
              <Tab
                on={machinePart === "fx-m-capacity"}
                onClick={() => scrollToId(scrollRef, "fx-m-capacity")}
                label="Capacity"
              />
              <Tab
                on={machinePart === "fx-m-storage"}
                onClick={() => scrollToId(scrollRef, "fx-m-storage")}
                label="Storage"
              />
              <Tab
                on={machinePart === "fx-m-software"}
                onClick={() => scrollToId(scrollRef, "fx-m-software")}
                label="Software"
              />
              <Tab
                on={machinePart === "fx-m-activity"}
                onClick={() => scrollToId(scrollRef, "fx-m-activity")}
                label="Recent"
              />
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
      <div ref={scrollRef} className="fp-scroll fxd-scroll" key={openId ?? "fleet"}>
        {openId === null ? (
          <div className="fxd-col">
            <section id="fx-machines" className="fxd-machines">
              <FleetLead fleet={fleet} />
              <div className="fxd-grid">
                {fleet.machines.map((machine) => (
                  <MachineCard
                    key={machine.id}
                    fleet={fleet}
                    machine={machine}
                    onOpen={() => open(machine.id)}
                    onCleanup={() => setCleanupId(machine.id)}
                    onGauge={onGauge(machine.id)}
                  />
                ))}
              </div>
            </section>
            <CapacityPanel fleet={fleet} onOpen={open} />
            <StoragePanel fleet={fleet} onCleanup={setCleanupId} onOpen={open} />
            <SoftwarePanel fleet={fleet} onReview={(machineId) => setReview({ machineId })} />
          </div>
        ) : (
          <div className="fxd-col">
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

function Tab({
  on,
  onClick,
  label,
  count,
  you = false,
}: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly label: string;
  readonly count?: string;
  readonly you?: boolean;
}): JSX.Element {
  return (
    <button type="button" className={on ? "ptab is-on" : "ptab"} onClick={onClick}>
      {label}
      {count !== undefined && <small className={you ? "is-you" : undefined}>{count}</small>}
    </button>
  );
}
