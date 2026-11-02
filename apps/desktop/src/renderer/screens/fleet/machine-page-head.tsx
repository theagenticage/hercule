import { Fragment, type JSX } from "react";
import type { MachineKind } from "@hercule/client-core/fleet";
import { buildMachineTransitionName } from "./machine-transition";
import { StatusDot } from "./machine-parts";
import { MachineIcon } from "./machine-icon";
import "./machine-page.css";

/**
 * Renders the head of a machine's page: its icon in a tile, its name, and
 * under the name its status and the facts the runner reported.
 *
 * - `status` is the dot and the word beside it. A machine that is simply
 *   online has no word of its own (`null`), and the head says "Online".
 * - `facts` are the pieces of text after the status, such as "darwin · arm64"
 *   and "16 GiB", drawn with a dot between them. The runner's own line comes
 *   last: "Runner 0.9.3", and "update available" in the muted colour after
 *   it when `isRunnerBehind`.
 * - The head carries the view-transition name that the machine's card on the
 *   Fleet page carries too (`buildMachineTransitionName`).
 */
export function MachinePageHead({
  runnerId,
  name,
  kind,
  status,
  facts,
  runnerVersion,
  isRunnerBehind,
}: {
  readonly runnerId: string;
  readonly name: string;
  readonly kind: MachineKind;
  readonly status: {
    readonly tone: "online" | "offline" | "draining";
    readonly word: string | null;
  };
  readonly facts: readonly string[];
  readonly runnerVersion: string | null;
  readonly isRunnerBehind: boolean;
}): JSX.Element {
  const word = status.word ?? "Online";
  const pieces = [
    ...facts,
    ...(runnerVersion === null ? [] : [`Runner ${runnerVersion}`]),
    ...(isRunnerBehind ? ["update available"] : []),
  ];
  return (
    <header
      className="machine-page-head"
      style={{ viewTransitionName: buildMachineTransitionName(runnerId) }}
    >
      <span className="machine-page-tile">
        <MachineIcon kind={kind} size={22} />
      </span>
      <div className="machine-page-head-text">
        <h2>{name}</h2>
        <p>
          <span className="machine-page-status">
            <StatusDot status={{ tone: status.tone, word }} />
            {word}
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
 * what limits it, such as "Room for 4 more, under its cap of 16". The number
 * after "Room for" is bold.
 */
export function MachinePageRoomLine({ line }: { readonly line: string }): JSX.Element {
  const room = /^(Room for )(\d+)(.*)$/s.exec(line);
  return (
    <p className="machine-page-room">
      {room === null ? (
        line
      ) : (
        <>
          {room[1]}
          <b>{room[2]}</b>
          {room[3]}
        </>
      )}
    </p>
  );
}
