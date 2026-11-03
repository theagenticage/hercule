import type { JSX, ReactNode } from "react";
import type { MachineInstruments, MeterInstrument } from "@hercule/client-core/machine-page";
import type { MachineGraphs, UnavailableGraph } from "@hercule/client-core/machine-graphs";
import {
  CpuGraphFigure,
  DiskGraphFigure,
  MemoryGraphFigure,
  SessionsGraphFigure,
  UnavailableGraphFrame,
} from "./machine-graph";
import { GaugeValue, Meter } from "./machine-parts";
import { SessionsFigure } from "./sessions-drawing";
import "./machine-page.css";

/**
 * Returns the note to draw under an instrument's graph, or `null` for none.
 * A graph that has nothing to draw shows its own sentence in its frame, so an
 * instrument note that is the same sentence is left out, and the tile never
 * says it twice.
 */
const pickNote = (
  note: string,
  graph: { readonly kind: "drawn" } | UnavailableGraph,
): string | null => (graph.kind === "unavailable" && graph.note === note ? null : note);

/**
 * Renders one instrument: its label, its big value with the unit in small
 * after it, what draws it (`children`: a meter, or the sessions' drawing),
 * its graph (`graph`), and the note under that. The value and the meter take
 * the colour of the instrument's level. `note` is `null` when the graph's
 * frame already says it. `forecastText` is the line under the note that says
 * when the disk reaches its limit.
 */
function Instrument({
  label,
  instrument,
  note,
  forecastText,
  graph,
  children,
}: {
  readonly label: string;
  readonly instrument: Pick<MeterInstrument, "value" | "unit" | "level">;
  readonly note: string | null;
  readonly forecastText: string | null;
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
      {forecastText === null ? null : (
        <span className="machine-page-instrument-forecast">{forecastText}</span>
      )}
    </div>
  );
}

/**
 * Renders the four instruments of a machine's page, in a row: Sessions, CPU,
 * Memory and Disk. Sessions is drawn as the cards draw it, the others as a
 * meter. Each has its graph between the meter and the note (`graphs`).
 *
 * - The Disk graph is marigold while the disk gauge is marigold or red. Its
 *   forecast, when there is one, is a line of its own under the note.
 * - A graph with nothing to draw shows its sentence in its frame, and the
 *   note under it is left out when it is the same sentence.
 *
 * An away machine (its Sessions drawing says so) is drawn in quieter inks, as
 * on its card, and its Sessions drawing is an outline. The instruments
 * themselves already say what an away machine shows. The row holds four
 * columns while its place is wide and two when it is not.
 */
export function MachinePageInstruments({
  instruments,
  graphs,
}: {
  readonly instruments: MachineInstruments;
  readonly graphs: MachineGraphs;
}): JSX.Element {
  const { sessions, cpu, memory, disk } = instruments;
  return (
    <div className={`machine-page-instruments-box${sessions.drawing.isAway ? " is-away" : ""}`}>
      <div className="machine-page-instruments">
        <Instrument
          label="Sessions"
          instrument={sessions}
          note={sessions.note}
          forecastText={null}
          graph={<SessionsGraphFigure graph={graphs.sessions} />}
        >
          <SessionsFigure drawing={sessions.drawing} size="card" />
        </Instrument>
        <Instrument
          label="CPU"
          instrument={cpu}
          note={pickNote(cpu.note, graphs.cpu)}
          forecastText={null}
          graph={
            graphs.cpu.kind === "drawn" ? (
              <CpuGraphFigure graph={graphs.cpu} />
            ) : (
              <UnavailableGraphFrame graph={graphs.cpu} />
            )
          }
        >
          <Meter share={cpu.share} level={cpu.level} />
        </Instrument>
        <Instrument
          label="Memory"
          instrument={memory}
          note={pickNote(memory.note, graphs.memory)}
          forecastText={null}
          graph={
            graphs.memory.kind === "drawn" ? (
              <MemoryGraphFigure graph={graphs.memory} />
            ) : (
              <UnavailableGraphFrame graph={graphs.memory} />
            )
          }
        >
          <Meter share={memory.share} level={memory.level} />
        </Instrument>
        <Instrument
          label="Disk"
          instrument={disk}
          note={pickNote(disk.note, graphs.disk)}
          forecastText={graphs.disk.kind === "drawn" ? graphs.disk.forecastText : null}
          graph={
            graphs.disk.kind === "drawn" ? (
              <DiskGraphFigure graph={graphs.disk} tone={disk.level === "normal" ? "ink" : "you"} />
            ) : (
              <UnavailableGraphFrame graph={graphs.disk} />
            )
          }
        >
          <Meter share={disk.share} level={disk.level} />
        </Instrument>
      </div>
    </div>
  );
}
