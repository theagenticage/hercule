/**
 * Tests for how the run graph draws each edge:
 * - an edge the run went along is solid;
 * - an edge into the step running now has flowing dashes;
 * - an edge the run chose not to take is dashed and faded;
 * - an edge the run has not come to yet is dashed, but not faded;
 * - a capped edge shows how often the run went along it out of its cap;
 * - the edge a run failed on is drawn in the failure colour.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RunGraph, RunGraphEdge } from "@hercule/client-core";
import { RunGraphView } from "./run-graph-view";

/** The class that makes an edge's dashes flow, from the shared stylesheet. */
const FLOW_CLASS = "hercule-edge-flow";

/** Returns an edge the run graph draws, with no cap and no failure. */
const edge = (from: string, to: string, travel: RunGraphEdge["travel"]): RunGraphEdge => ({
  from,
  to,
  travel,
  traversalBadge: undefined,
  isFailedEdge: false,
  isOverLimit: false,
});

/**
 * A running run in a loop: `lookup` found no match and led to `file`, which
 * led to `count`; `count` went back to `file` twice, out of a cap of three,
 * and `file` is running now. `lookup` did not take its edge to `reuse`, and
 * the run has not come to `escalate` yet.
 */
const RUN_GRAPH: RunGraph = {
  status: "running",
  nodes: [
    {
      id: "lookup",
      kind: "action",
      progress: { state: "completed" },
      iterationCount: 1,
      iterationLabel: undefined,
    },
    {
      id: "reuse",
      kind: "action",
      progress: { state: "unreached" },
      iterationCount: 0,
      iterationLabel: undefined,
    },
    {
      id: "file",
      kind: "action",
      progress: { state: "running" },
      iterationCount: 3,
      iterationLabel: "×3",
    },
    {
      id: "count",
      kind: "action",
      progress: { state: "completed" },
      iterationCount: 2,
      iterationLabel: "×2",
    },
    {
      id: "escalate",
      kind: "action",
      progress: { state: "unreached" },
      iterationCount: 0,
      iterationLabel: undefined,
    },
  ],
  edges: [
    edge("lookup", "reuse", "notTaken"),
    edge("lookup", "file", "active"),
    edge("file", "count", "fired"),
    { ...edge("count", "file", "active"), maxTraversals: 3, traversalBadge: "2/3" },
    edge("count", "escalate", "notYet"),
  ],
};

/** Renders a run graph in a pane big enough to lay it out. */
const renderRunGraph = (runGraph: RunGraph): void => {
  render(
    <div style={{ width: 800, height: 400 }}>
      <RunGraphView runGraph={runGraph} now={Date.now()} />
    </div>,
  );
};

/** Returns the drawn curve of the edge from `from` to `to`. */
const getEdgeCurve = (from: string, to: string): SVGPathElement => {
  const drawn = screen.getByRole("img", { name: `Edge from ${from} to ${to}` });
  const curve = drawn.querySelector<SVGPathElement>("path.react-flow__edge-path");
  if (curve === null) throw new Error(`the edge from ${from} to ${to} has no curve`);
  return curve;
};

describe("RunGraphView > edges", () => {
  it("draws a fired edge solid, and an edge into the running step flowing", () => {
    renderRunGraph(RUN_GRAPH);

    const fired = getEdgeCurve("file", "count");
    expect(fired.style.strokeDasharray).toBe("");
    expect(fired.classList.contains(FLOW_CLASS)).toBe(false);

    const active = getEdgeCurve("lookup", "file");
    expect(active.classList.contains(FLOW_CLASS)).toBe(true);
  });

  it("draws an edge not taken and an edge not reached yet both dashed, but not alike", () => {
    renderRunGraph(RUN_GRAPH);

    const notTaken = getEdgeCurve("lookup", "reuse");
    const notYet = getEdgeCurve("count", "escalate");
    expect(notTaken.style.strokeDasharray).not.toBe("");
    expect(notYet.style.strokeDasharray).not.toBe("");
    expect(notTaken.classList.contains(FLOW_CLASS)).toBe(false);
    expect(notYet.classList.contains(FLOW_CLASS)).toBe(false);
    // A reader tells "the run chose not to go here" from "the run has not got here yet".
    const drawnAs = (curve: SVGPathElement): string =>
      [curve.style.stroke, curve.style.strokeDasharray, curve.style.opacity].join("|");
    expect(drawnAs(notTaken)).not.toBe(drawnAs(notYet));
  });

  it("shows a capped edge's traversals out of its cap, not the editor's max badge", () => {
    renderRunGraph(RUN_GRAPH);

    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.queryByText("max 3")).toBeNull();
  });

  it("draws the edge a run failed on at its iteration limit with its badge in the failure colour", () => {
    renderRunGraph({
      ...RUN_GRAPH,
      status: "failed",
      edges: RUN_GRAPH.edges.map((drawn) =>
        drawn.from === "count" && drawn.to === "file"
          ? {
              ...drawn,
              travel: "fired",
              traversalBadge: "3/3",
              isFailedEdge: true,
              isOverLimit: true,
            }
          : drawn,
      ),
    });

    const badge = screen.getByText("3/3");
    expect(badge.classList.contains("text-fail")).toBe(true);
    expect(getEdgeCurve("count", "file").style.stroke).toContain("--fail");
  });

  it("draws the edge whose condition failed to evaluate in the failure colour", () => {
    renderRunGraph({
      ...RUN_GRAPH,
      status: "failed",
      edges: RUN_GRAPH.edges.map((drawn) =>
        drawn.from === "count" && drawn.to === "escalate"
          ? { ...drawn, isFailedEdge: true }
          : drawn,
      ),
    });

    expect(getEdgeCurve("count", "escalate").style.stroke).toContain("--fail");
    expect(getEdgeCurve("file", "count").style.stroke).not.toContain("--fail");
  });
});
