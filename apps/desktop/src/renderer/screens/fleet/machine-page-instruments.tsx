import type { JSX, ReactNode } from "react";
import type { MachineInstruments, MeterInstrument } from "@hercule/client-core/machine-page";
import type { MachineGraphs } from "@hercule/client-core/machine-graphs";
import {
  CpuGraphFigure,
  MemoryGraphFigure,
  SessionsGraphFigure,
  UnavailableGraphFrame,
} from "./machine-graph";
import { GaugeValue, Meter } from "./machine-parts";
import { SessionsFigure } from "./sessions-drawing";
import "./machine-page.css";

/**
 * Renders one instrument: its label, its big value with the unit in small
 * after it, what draws it (`children`: a meter, or the sessions' drawing),
 * its graph (`graph`), and the note under that. The value and the meter take
 * the colour of the instrument's level. `note` is `null` when the graph is an
 * unavailable frame, which shows the note itself.
 */
function Instrument({
  label,
  instrument,
  note,
  graph,
  children,
}: {
  readonly label: string;
  readonly instrument: Pick<MeterInstrument, "value" | "unit" | "level">;
  readonly note: string | null;
  readonly graph: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={`machine-page-instrument machine-page-instrument--${instrument.level}`}>
      <span className="machine-page-instrument-label">{label}</span>
      <GaugeValue gauge={instrument} />
      {children}
      {graph}
      {note === null ? null : <span className="machine-page-instrument-note">{note}</span>}
    </div>
  );
}

/**
 * Renders the three instruments of a machine's page, in a row: Sessions, CPU
 * and Memory. Sessions is drawn as the cards draw it, the others as a meter.
 * Each has its graph between the meter and the note (`graphs`).
 *
 * A graph with nothing to draw shows the instrument's note in its frame, and
 * the note line under it is left out, so the tile never says it twice.
 *
 * An away machine (its Sessions drawing says so) is drawn in quieter inks, as
 * on its card, and its Sessions drawing is an outline. The instruments
 * themselves already say what an away machine shows. The row holds three
 * columns while its place is wide. When it is not, Sessions takes a row of its
 * own, so its 16 slots are never cut off (waiting blocks beyond the column
 * are, as on a card), and CPU and Memory share the next.
 */
export function MachinePageInstruments({
  instruments,
  graphs,
}: {
  readonly instruments: MachineInstruments;
  readonly graphs: MachineGraphs;
}): JSX.Element {
  const { sessions, cpu, memory } = instruments;
  return (
    <div className={`machine-page-instruments-box${sessions.drawing.isAway ? " is-away" : ""}`}>
      <div className="machine-page-instruments">
        <Instrument
          label="Sessions"
          instrument={sessions}
          note={sessions.note}
          graph={<SessionsGraphFigure graph={graphs.sessions} />}
        >
          <SessionsFigure drawing={sessions.drawing} size="card" />
        </Instrument>
        <Instrument
          label="CPU"
          instrument={cpu}
          note={graphs.cpu.kind === "drawn" ? cpu.note : null}
          graph={
            graphs.cpu.kind === "drawn" ? (
              <CpuGraphFigure graph={graphs.cpu} />
            ) : (
              <UnavailableGraphFrame note={cpu.note} />
            )
          }
        >
          <Meter share={cpu.share} level={cpu.level} />
        </Instrument>
        <Instrument
          label="Memory"
          instrument={memory}
          note={graphs.memory.kind === "drawn" ? memory.note : null}
          graph={
            graphs.memory.kind === "drawn" ? (
              <MemoryGraphFigure graph={graphs.memory} />
            ) : (
              <UnavailableGraphFrame note={memory.note} />
            )
          }
        >
          <Meter share={memory.share} level={memory.level} />
        </Instrument>
      </div>
    </div>
  );
}
