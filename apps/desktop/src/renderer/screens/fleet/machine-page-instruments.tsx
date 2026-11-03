import type { JSX, ReactNode } from "react";
import type { MachineInstrument, MachineInstruments } from "@hercule/client-core/machine-page";
import { Meter } from "./machine-parts";
import { SessionsFigure } from "./sessions-drawing";
import "./machine-page.css";

/**
 * Renders one instrument: its label, its big value with the unit in small
 * after it, what draws it (`children`: a meter, or the sessions' drawing),
 * and the note under that. The value and the meter take the colour of the
 * instrument's level.
 */
function Instrument({
  label,
  instrument,
  children,
}: {
  readonly label: string;
  readonly instrument: MachineInstrument;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={`machine-page-instrument machine-page-instrument--${instrument.level}`}>
      <span className="machine-page-instrument-label">{label}</span>
      <b>
        {instrument.value}
        {instrument.unit === "" ? null : <small>{instrument.unit}</small>}
      </b>
      {children}
      <span className="machine-page-instrument-note">{instrument.note}</span>
    </div>
  );
}

/**
 * Renders the four instruments of a machine's page, in a row: Sessions, CPU,
 * Memory and Disk, each from its `MachineInstrument`. Sessions is drawn as the
 * cards draw it, the others as a meter.
 *
 * A machine that is `isAway` keeps the values it last reported, in quieter
 * inks as on its card. Its sessions are the one exception: they cannot be
 * known, so the number is a dash and the drawing an outline, as on the card.
 * The row holds four columns while its place is wide and two when it is not.
 */
export function MachinePageInstruments({
  instruments,
  isAway,
}: {
  readonly instruments: MachineInstruments;
  readonly isAway: boolean;
}): JSX.Element {
  const { sessions, cpu, memory, disk } = instruments;
  return (
    <div className={`machine-page-instruments-box${isAway ? " is-away" : ""}`}>
      <div className="machine-page-instruments">
        <Instrument label="Sessions" instrument={isAway ? { ...sessions, value: "–" } : sessions}>
          <SessionsFigure drawing={sessions.drawing} size="card" isAway={isAway} />
        </Instrument>
        <Instrument label="CPU" instrument={cpu}>
          <Meter share={cpu.share} level={cpu.level} />
        </Instrument>
        <Instrument label="Memory" instrument={memory}>
          <Meter share={memory.share} level={memory.level} />
        </Instrument>
        <Instrument label="Disk" instrument={disk}>
          <Meter share={disk.share} level={disk.level} />
        </Instrument>
      </div>
    </div>
  );
}
