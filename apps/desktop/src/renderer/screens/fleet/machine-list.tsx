import type { JSX, ReactNode } from "react";
import type { MachineSummary } from "@hercule/client-core/fleet";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { MachineIcon } from "./machine-icon";
import { Meter, NeedLine, OpenMachine, StatusDot } from "./machine-parts";
import { buildMachineTransitionName } from "./machine-transition";
import { SessionsFigure } from "./sessions-drawing";
import "./fleet-page.css";

/**
 * Renders one machine as a row of the list. It draws what `machine` holds and
 * works out nothing, and the status label is always drawn under the name.
 *
 * The machine's name is the row's one way to open the machine: its button
 * covers the whole row and calls `onOpen` with the runner id. `allow` is the
 * Allow button, drawn beside a need of waiting sessions.
 *
 * Every row carries the view transition name of its machine, so the browser
 * can grow the row into the head of the machine's page, and back.
 */
export function MachineRow({
  machine,
  allow,
  onOpen,
}: {
  readonly machine: MachineSummary;
  readonly allow: ReactNode;
  readonly onOpen: (runnerId: string) => void;
}): JSX.Element {
  const { runnerId, status, isAway, drawing, disk, memory, roomText, need } = machine;

  return (
    <div
      role="row"
      className={`fleet-row${isAway ? " is-away" : ""}`}
      style={{ viewTransitionName: buildMachineTransitionName(runnerId) }}
    >
      <span role="cell" className="fleet-row-dot">
        <StatusDot status={status} />
      </span>
      <span role="cell" className="fleet-row-name">
        <span className="fleet-row-icon">
          <MachineIcon kind={machine.kind} size={14} />
        </span>
        <span className="fleet-row-name-text">
          <OpenMachine runnerId={runnerId} name={machine.name} onOpen={onOpen} />
          <small>{status.label}</small>
        </span>
      </span>
      <span role="cell" className="fleet-cell">
        <SessionsFigure drawing={drawing} size="list" isAway={isAway} />
        <small className={drawing.waiting > 0 ? "is-you" : undefined}>
          {isAway ? "–" : drawing.running} of {drawing.cap}
          {drawing.waiting > 0 && ` · ${String(drawing.waiting)} waiting`}
        </small>
      </span>
      <span role="cell" className="fleet-cell fleet-col-room">
        <b>{roomText ?? "–"}</b>
      </span>
      <span role="cell" className="fleet-cell fleet-cell--line fleet-col-disk">
        {disk === null ? (
          <b>–</b>
        ) : (
          <>
            <b className={disk.level === "fail" ? "is-fail" : undefined}>
              {disk.amount} {disk.unit}
            </b>
            <small>free</small>
          </>
        )}
      </span>
      <span role="cell" className="fleet-cell fleet-col-mem">
        {memory === null ? (
          <b>–</b>
        ) : (
          <span className="fleet-row-meter">
            <Meter share={memory.share} level={memory.level} />
            <b className={memory.level === "normal" ? undefined : `is-${memory.level}`}>
              {memory.percent}%
            </b>
          </span>
        )}
      </span>
      <span role="cell" className="fleet-row-need">
        <NeedLine need={need} allow={allow} />
      </span>
      <ChevronRightIcon size={14} />
    </div>
  );
}

/**
 * Renders the table the machine rows sit in, with its columns lining up:
 * Machine, Sessions, Room, Disk, Memory and Needs you. Under 1030px of width
 * the Room and Memory columns go, because the machine's page shows them, and
 * under 720px the Disk column goes too. The rows draw what a card draws, with
 * the sessions smaller and the disk as its free space alone.
 */
export function MachineList({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="fleet-list" role="table" aria-label="Machines">
      <div className="fleet-heads" role="row">
        <span role="presentation" />
        <span role="columnheader">Machine</span>
        <span role="columnheader">Sessions</span>
        <span role="columnheader" className="fleet-col-room">
          Room
        </span>
        <span role="columnheader" className="fleet-col-disk">
          Disk
        </span>
        <span role="columnheader" className="fleet-col-mem">
          Memory
        </span>
        <span role="columnheader">Needs you</span>
        <span role="presentation" />
      </div>
      {children}
    </div>
  );
}
