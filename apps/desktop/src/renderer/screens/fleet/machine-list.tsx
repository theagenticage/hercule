import type { JSX } from "react";
import { decideMachineKind, summarizeMachine, type FleetMachine } from "@hercule/client-core/fleet";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { MachineIcon } from "./machine-icon";
import { Meter, NeedLine, OpenMachine, StatusDot } from "./machine-parts";
import { buildMachineTransitionName } from "./machine-transition";
import { SessionsFigure } from "./sessions-drawing";
import "./fleet-page.css";

/** Renders one machine as a row of the list. See `MachineList` for the props. */
function MachineRow({
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
  const { status, isAway, drawing, disk, memory, room, need } = summarizeMachine(
    machine,
    timezone,
    now,
  );

  return (
    <div
      role="row"
      className={`fleet-row${isAway ? " is-away" : ""}`}
      style={{ viewTransitionName: buildMachineTransitionName(runner.id) }}
    >
      <span role="cell" className="fleet-row-dot">
        <StatusDot status={status} />
      </span>
      <span role="cell" className="fleet-row-name">
        <span className="fleet-row-icon">
          <MachineIcon kind={decideMachineKind(runner.facts)} size={14} />
        </span>
        <span className="fleet-row-name-text">
          <OpenMachine runnerId={runner.id} name={runner.name} onOpen={onOpen} />
          <small>{status.word ?? "Online"}</small>
        </span>
      </span>
      <span role="cell" className="fleet-cell">
        <SessionsFigure drawing={drawing} size="list" away={isAway} />
        <small className={drawing.waiting > 0 ? "is-you" : undefined}>
          {isAway ? "–" : drawing.running} of {drawing.cap}
          {drawing.waiting > 0 && ` · ${String(drawing.waiting)} waiting`}
        </small>
      </span>
      <span role="cell" className="fleet-cell fleet-col-room">
        <b>{room ?? "–"}</b>
      </span>
      <span role="cell" className="fleet-cell">
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
            <Meter share={memory.percent / 100} level={memory.level} />
            <b className={memory.level === "normal" ? undefined : `is-${memory.level}`}>
              {memory.percent}%
            </b>
          </span>
        )}
      </span>
      <span role="cell" className="fleet-row-need">
        <NeedLine runnerId={runner.id} need={need} allowPending={allowPending} onAllow={onAllow} />
      </span>
      <ChevronRightIcon size={14} />
    </div>
  );
}

/**
 * Renders the machines as a table with one row per machine, its columns
 * lining up: Machine, Sessions, Room, Disk, Memory and Needs you. Under 900px
 * of width the Room and Memory columns go, because the machine's page shows
 * them. The rows draw what a card draws, with the sessions smaller and the disk
 * as its free space alone.
 *
 * - `onOpen` is called with the runner id when the user presses a row. The
 *   machine's name is the row's one way to open the machine: its button covers
 *   the whole row.
 * - `onAllow` is called by the row's Allow button; `pendingAllowRunnerIds`
 *   holds the machines whose Allow button shows that it is saving.
 *
 * Every row carries the view transition name of its machine, so the browser
 * can grow the row into the head of the machine's page, and back.
 */
export function MachineList({
  machines,
  timezone,
  now,
  pendingAllowRunnerIds,
  onOpen,
  onAllow,
}: {
  readonly machines: readonly FleetMachine[];
  readonly timezone: string;
  readonly now: Date;
  readonly pendingAllowRunnerIds: ReadonlySet<string>;
  readonly onOpen: (runnerId: string) => void;
  readonly onAllow: (runnerId: string, cap: number) => void;
}): JSX.Element {
  return (
    <div className="fleet-list" role="table" aria-label="Machines">
      <div className="fleet-heads" role="row">
        <span role="presentation" />
        <span role="columnheader">Machine</span>
        <span role="columnheader">Sessions</span>
        <span role="columnheader" className="fleet-col-room">
          Room
        </span>
        <span role="columnheader">Disk</span>
        <span role="columnheader" className="fleet-col-mem">
          Memory
        </span>
        <span role="columnheader">Needs you</span>
        <span role="presentation" />
      </div>
      {machines.map((machine) => (
        <MachineRow
          key={machine.runner.id}
          machine={machine}
          timezone={timezone}
          now={now}
          allowPending={pendingAllowRunnerIds.has(machine.runner.id)}
          onOpen={onOpen}
          onAllow={onAllow}
        />
      ))}
    </div>
  );
}
