import type { JSX, ReactNode } from "react";
import type {
  CpuGraph,
  DiskGraph,
  GraphBand,
  GraphLine,
  MemoryGraph,
  SessionsGraph,
  UnavailableGraph,
} from "@hercule/client-core/machine-graphs";
import "./machine-graph.css";

/** The width of a graph's drawing space. The svg stretches it to the tile's width. */
const DRAWING_WIDTH = 100;

/** The height of a graph's drawing space and of the graph, in pixels. */
const DRAWING_HEIGHT = 40;

/** The room kept above and below a line, so a stroke on the top or bottom edge is not cut off. */
const EDGE_INSET = 1;

/** Rounds to two decimals, so the path strings stay short. */
const round = (value: number): number => Math.round(value * 100) / 100;

/** Returns the drawing space's `x` for a graph `x` between 0 and 1. */
const toDrawingX = (x: number): number => round(x * DRAWING_WIDTH);

/** Returns the drawing space's `y` for a graph `y` between 0 (the bottom) and 1 (the top). */
const toDrawingY = (y: number): number =>
  round(DRAWING_HEIGHT - EDGE_INSET - y * (DRAWING_HEIGHT - 2 * EDGE_INSET));

/**
 * Builds the path data of a line with one stretch per run: each run starts
 * with `M`, so a gap in the history stays a gap. A run of one point is drawn
 * as a zero-length segment, which a round line cap shows as a dot.
 */
const buildLinePath = (runs: readonly GraphLine[]): string =>
  runs
    .map((run) => {
      const points = run.length === 1 ? [run[0]!, run[0]!] : run;
      return points
        .map(({ x, y }, index) => `${index === 0 ? "M" : "L"}${toDrawingX(x)},${toDrawingY(y)}`)
        .join(" ");
    })
    .join(" ");

/** Builds the path data of the area under a line, down to the bottom edge, one closed shape per run. */
const buildAreaPath = (runs: readonly GraphLine[]): string =>
  runs
    .map((run) => {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      return `${buildLinePath([run])} L${toDrawingX(last.x)},${DRAWING_HEIGHT} L${toDrawingX(first.x)},${DRAWING_HEIGHT} Z`;
    })
    .join(" ");

/** Builds the path data of a band, one closed shape per run: the high edge forward, then the low edge back. */
const buildBandPath = (runs: readonly GraphBand[]): string =>
  runs
    .map((run) => {
      const highs = run.map(
        ({ x, high }, index) => `${index === 0 ? "M" : "L"}${toDrawingX(x)},${toDrawingY(high)}`,
      );
      const lows = run.toReversed().map(({ x, low }) => `L${toDrawingX(x)},${toDrawingY(low)}`);
      return `${highs.join(" ")} ${lows.join(" ")} Z`;
    })
    .join(" ");

/** Builds the path data of a horizontal line across the whole graph at graph height `y`. */
const buildReferencePath = (y: number): string =>
  `M0,${toDrawingY(y)} L${DRAWING_WIDTH},${toDrawingY(y)}`;

/**
 * Renders the box every graph is drawn in: a 40px tall svg as wide as its
 * tile, with a drawing space that stretches to fit and strokes that keep their
 * width when it does. `tone` is `you` for a graph that has turned marigold. The
 * numbers beside a graph carry its meaning, so the svg is hidden from
 * assistive technology.
 */
function GraphBox({
  tone,
  children,
}: {
  readonly tone: "ink" | "you";
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <svg
      className={`machine-graph machine-graph--${tone}`}
      viewBox={`0 0 ${DRAWING_WIDTH} ${DRAWING_HEIGHT}`}
      preserveAspectRatio="none"
      height={DRAWING_HEIGHT}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * Renders the Sessions graph: the sessions running as a step area with its
 * outline, a marigold band where sessions waited, and the cap as a dashed line.
 */
export function SessionsGraphFigure({ graph }: { readonly graph: SessionsGraph }): JSX.Element {
  return (
    <GraphBox tone="ink">
      <path className="machine-graph-area" d={buildAreaPath(graph.running)} />
      <path className="machine-graph-waiting" d={buildBandPath(graph.waiting)} />
      <path className="machine-graph-line" d={buildLinePath(graph.running)} />
      <path className="machine-graph-cap" d={buildReferencePath(graph.capY)} />
    </GraphBox>
  );
}

/** Renders the CPU graph: the peak as a band and the average as a line. */
export function CpuGraphFigure({ graph }: { readonly graph: CpuGraph }): JSX.Element {
  return (
    <GraphBox tone="ink">
      <path className="machine-graph-band" d={buildBandPath(graph.peak)} />
      <path className="machine-graph-line" d={buildLinePath(graph.average)} />
    </GraphBox>
  );
}

/**
 * Renders the Memory graph: the highest memory in use as a band, the memory
 * in use as a line, and the 80% and 92% lines where it turns marigold and red.
 */
export function MemoryGraphFigure({ graph }: { readonly graph: MemoryGraph }): JSX.Element {
  return (
    <GraphBox tone="ink">
      <path className="machine-graph-band" d={buildBandPath(graph.highest)} />
      <path className="machine-graph-line" d={buildLinePath(graph.inUse)} />
      <path className="machine-graph-you-line" d={buildReferencePath(graph.youY)} />
      <path className="machine-graph-limit" d={buildReferencePath(graph.failY)} />
    </GraphBox>
  );
}

/**
 * Renders the Disk graph: the space in use as a line with an area under it,
 * the dashed forecast when there is one, and the disk limit as a dashed red
 * line. `tone` is `you` while the disk gauge is marigold or red.
 */
export function DiskGraphFigure({
  graph,
  tone,
}: {
  readonly graph: DiskGraph;
  readonly tone: "ink" | "you";
}): JSX.Element {
  return (
    <GraphBox tone={tone}>
      <path className="machine-graph-area" d={buildAreaPath(graph.inUse)} />
      <path className="machine-graph-line" d={buildLinePath(graph.inUse)} />
      {graph.forecast !== null && (
        <path className="machine-graph-forecast" d={buildLinePath([graph.forecast])} />
      )}
      <path className="machine-graph-limit" d={buildReferencePath(graph.limitY)} />
    </GraphBox>
  );
}

/**
 * Renders the frame of a graph that has nothing to draw, as tall as a graph,
 * with the sentence that says why and what to do. The sentence grows the frame
 * when it needs more than one graph's height.
 */
export function UnavailableGraphFrame({
  graph,
}: {
  readonly graph: UnavailableGraph;
}): JSX.Element {
  return <p className="machine-graph-frame">{graph.note}</p>;
}
