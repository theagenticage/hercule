import type { JSX, ReactNode } from "react";
import type { GaugeLevel, MachineSummary } from "@hercule/client-core/fleet";
import type { MachineFaces } from "@hercule/client-core/machine-work";
import { MachineIcon } from "./machine-icon";
import { GaugeValue, Meter, NeedLine, OpenMachine, StatusDot } from "./machine-parts";
import { buildMachineTransitionName } from "./machine-transition";
import { SessionsFigure } from "./sessions-drawing";
import { MachineFacesStack } from "./work-faces";
import "./fleet-page.css";

/**
 * Renders the grid the Fleet page's cards sit in: 4 cards per row when the
 * page column is wide, 1 when it is narrow. The columns follow the width of
 * the grid's own box (a container query), not the window's, so a card is never
 * narrower than 264px.
 */
export function MachineGrid({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="fleet-grid-box">
      <div className="fleet-grid">{children}</div>
    </div>
  );
}

/** Renders one gauge: a label, a value, and what draws it (a meter, or the sessions). */
function Gauge({
  label,
  level,
  isWide,
  children,
}: {
  readonly label: string;
  readonly level?: GaugeLevel | undefined;
  readonly isWide?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`fleet-gauge fleet-gauge--${level ?? "normal"}${isWide === true ? " fleet-gauge--wide" : ""}`}
    >
      <span className="fleet-gauge-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * Renders one machine as a card: its icon, name and status, its sessions
 * against the cap, its disk and memory gauges, how much room it has, and the
 * one thing that needs the user with the button that fixes it. It draws what `machine` holds and works out nothing.
 *
 * The status label is drawn only while the machine is not plainly online; the
 * dot alone says "online".
 *
 * The machine's name is the card's one way to open the machine: its button
 * covers the whole card and calls `onOpen` with the runner id. `allow` is the
 * Allow button, drawn beside a need of waiting sessions. `faces` are the faces
 * of the work on the machine, drawn left of its room; `undefined` when the
 * machine has no work.
 *
 * Every card carries the view transition name of its machine, so the browser
 * can grow the card into the head of the machine's page, and back. Runner ids
 * are unique, so the names are.
 */
export function MachineCard({
  machine,
  faces,
  allow,
  onOpen,
}: {
  readonly machine: MachineSummary;
  readonly faces: MachineFaces | undefined;
  readonly allow: ReactNode;
  readonly onOpen: (runnerId: string) => void;
}): JSX.Element {
  const { runnerId, status, isAway, drawing, disk, memory } = machine;
  const isLabelled = status.tone !== "online";

  return (
    <div
      className={`fleet-card${isAway ? " is-away" : ""}`}
      style={{ viewTransitionName: buildMachineTransitionName(runnerId) }}
    >
      <div className="fleet-card-head">
        <span className="fleet-card-icon">
          <MachineIcon kind={machine.kind} size={16} />
        </span>
        <OpenMachine runnerId={runnerId} name={machine.name} onOpen={onOpen} />
        <span className="fleet-card-state">
          <StatusDot status={status} namesState={!isLabelled} />
          {isLabelled && status.label}
        </span>
      </div>
      <div className="fleet-gauges">
        <Gauge label="Sessions" isWide>
          <div className="fleet-sessions-line">
            <GaugeValue gauge={{ value: drawing.runningText, unit: drawing.capText }} />
            <SessionsFigure drawing={drawing} size="card" />
          </div>
        </Gauge>
        <Gauge label="Disk" level={disk.level}>
          <GaugeValue gauge={disk} />
          <Meter share={disk.share} level={disk.level} />
        </Gauge>
        <Gauge label="Memory" level={memory.level}>
          <GaugeValue gauge={memory} />
          <Meter share={memory.share} level={memory.level} />
        </Gauge>
      </div>
      <div className="fleet-card-crew">
        {faces !== undefined && <MachineFacesStack faces={faces} size={20} unit="group" />}
        {machine.roomText !== null && <span className="fleet-room">{machine.roomText}</span>}
      </div>
      <div className="fleet-card-foot">
        <NeedLine need={machine.need} allow={allow} />
      </div>
    </div>
  );
}
