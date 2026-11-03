import { Fragment, type JSX } from "react";
import type { MachineHead } from "@hercule/client-core/machine-page";
import type { FleetTextPart } from "@hercule/client-core/fleet";
import { FleetText } from "./fleet-text";
import { buildMachineTransitionName } from "./machine-transition";
import { StatusDot } from "./machine-parts";
import { MachineIcon } from "./machine-icon";
import "./machine-page.css";

/**
 * Renders the head of a machine's page: its icon in a tile, its name, and
 * under the name its status and the pieces of text after it, drawn with a dot
 * between them: the facts the runner reported, then the runner program's own
 * line with "update available" after it when the controller runs a newer
 * release.
 *
 * The head carries the view-transition name that the machine's card on the
 * Fleet page carries too (`buildMachineTransitionName`).
 */
export function MachinePageHead({
  runnerId,
  head,
}: {
  readonly runnerId: string;
  readonly head: MachineHead;
}): JSX.Element {
  const pieces = [
    ...head.facts,
    ...(head.runner === null
      ? []
      : [head.runner.text, ...(head.runner.updateText === null ? [] : [head.runner.updateText])]),
  ];
  return (
    <header
      className="machine-page-head"
      style={{ viewTransitionName: buildMachineTransitionName(runnerId) }}
    >
      <span className="machine-page-tile">
        <MachineIcon kind={head.kind} size={22} />
      </span>
      <div className="machine-page-head-text">
        <h2>{head.name}</h2>
        <p>
          <span className="machine-page-status">
            <StatusDot status={head.status} />
            {head.status.label}
          </span>
          {pieces.map((piece) => (
            <Fragment key={piece}>
              <span aria-hidden="true">·</span>
              <span>{piece}</span>
            </Fragment>
          ))}
        </p>
      </div>
    </header>
  );
}

/**
 * Renders the room line under the head: what the machine can still start and
 * what limits it, such as "Room for 4 more, under its cap of 16". Its numbers
 * are bold.
 */
export function MachinePageRoomLine({
  line,
}: {
  readonly line: readonly FleetTextPart[];
}): JSX.Element {
  return (
    <p className="machine-page-room">
      <FleetText parts={line} />
    </p>
  );
}
