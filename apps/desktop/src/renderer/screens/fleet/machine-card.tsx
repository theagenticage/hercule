import type { JSX, ReactNode } from "react";
import {
  decideMachineKind,
  summarizeMachine,
  type FleetMachine,
  type GaugeLevel,
} from "@hercule/client-core/fleet";
import { MachineIcon } from "./machine-icon";
import { Meter, NeedLine, OpenMachine, StatusDot } from "./machine-parts";
import { buildMachineTransitionName } from "./machine-transition";
import { SessionsFigure } from "./sessions-drawing";
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
  level = "normal",
  isWide = false,
  children,
}: {
  readonly label: string;
  readonly level?: GaugeLevel | undefined;
  readonly isWide?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={`fleet-gauge fleet-gauge--${level}${isWide ? " fleet-gauge--wide" : ""}`}>
      <span className="fleet-gauge-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * Renders one machine as a card: its icon, name and status, its sessions
 * against the cap, its disk and memory, how much room it has, and the one
 * thing that needs the user with the button that fixes it. The card computes
 * all of this from `machine` with `summarizeMachine`.
 *
 * The machine's name is the card's one way to open the machine: its button
 * covers the whole card and calls `onOpen` with the runner id. The Allow button
 * calls `onAllow` instead, and shows that it is saving while `allowPending` is
 * true.
 *
 * Every card carries the view transition name of its machine, so the browser
 * can grow the card into the head of the machine's page, and back. Runner ids
 * are unique, so the names are.
 */
export function MachineCard({
  machine,
  timezone,
  now,
  allowPending,
  onOpen,
  onAllow,
}: {
  readonly machine: FleetMachine;
  readonly timezone: string;
  readonly now: Date;
  readonly allowPending: boolean;
  readonly onOpen: (runnerId: string) => void;
  readonly onAllow: (runnerId: string, cap: number) => void;
}): JSX.Element {
  const { runner } = machine;
  const summary = summarizeMachine(machine, timezone, now);
  const { status, isAway, drawing, disk, memory } = summary;

  return (
    <div
      className={`fleet-card${isAway ? " is-away" : ""}`}
      style={{ viewTransitionName: buildMachineTransitionName(runner.id) }}
    >
      <div className="fleet-card-head">
        <span className="fleet-card-icon">
          <MachineIcon kind={decideMachineKind(runner.facts)} size={16} />
        </span>
        <OpenMachine runnerId={runner.id} name={runner.name} onOpen={onOpen} />
        <span className="fleet-card-state">
          <StatusDot status={status} />
          {status.word}
        </span>
      </div>
      <div className="fleet-gauges">
        <Gauge label="Sessions" isWide>
          <div className="fleet-sessions-line">
            <b>
              {isAway ? "–" : drawing.running}
              <small> of {drawing.cap}</small>
            </b>
            <SessionsFigure drawing={drawing} size="card" isAway={isAway} />
          </div>
        </Gauge>
        <Gauge label="Disk" level={disk?.level}>
          <b>
            {disk === null ? (
              "–"
            ) : (
              <>
                {disk.amount}
                <small> {disk.unit} free</small>
              </>
            )}
          </b>
          <Meter share={0} level="normal" />
        </Gauge>
        <Gauge label="Memory" level={memory?.level}>
          <b>
            {memory === null ? (
              "–"
            ) : (
              <>
                {memory.percent}
                <small>%</small>
              </>
            )}
          </b>
          <Meter
            share={memory === null ? 0 : memory.percent / 100}
            level={memory?.level ?? "normal"}
          />
        </Gauge>
      </div>
      <div className="fleet-card-crew">
        {summary.room !== null && <span className="fleet-room">{summary.room}</span>}
      </div>
      <div className="fleet-card-foot">
        <NeedLine
          runnerId={runner.id}
          need={summary.need}
          allowPending={allowPending}
          onAllow={onAllow}
        />
      </div>
    </div>
  );
}
