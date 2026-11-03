import type { JSX, ReactNode } from "react";
import type { MachineInstruments, MeterInstrument } from "@hercule/client-core/machine-page";
import { GaugeValue, Meter } from "./machine-parts";
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
  readonly instrument: Pick<MeterInstrument, "value" | "unit" | "level" | "note">;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={`machine-page-instrument machine-page-instrument--${instrument.level}`}>
      <span className="machine-page-instrument-label">{label}</span>
      <GaugeValue gauge={instrument} />
      {children}
      <span className="machine-page-instrument-note">{instrument.note}</span>
    </div>
  );
}

/**
 * Renders the four instruments of a machine's page, in a row: Sessions, CPU,
 * Memory and Disk. Sessions is drawn as the cards draw it, the others as a
 * meter.
 *
 * An away machine (its Sessions drawing says so) is drawn in quieter inks, as
 * on its card, and its Sessions drawing is an outline. The instruments
 * themselves already say what an away machine shows. The row holds four
 * columns while its place is wide and two when it is not.
 */
export function MachinePageInstruments({
  instruments,
}: {
  readonly instruments: MachineInstruments;
}): JSX.Element {
  const { sessions, cpu, memory, disk } = instruments;
  return (
    <div className={`machine-page-instruments-box${sessions.drawing.isAway ? " is-away" : ""}`}>
      <div className="machine-page-instruments">
        <Instrument label="Sessions" instrument={sessions}>
          <SessionsFigure drawing={sessions.drawing} size="card" />
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
