/**
 * Tests for how the run graph draws each edge: an edge the run has not gone
 * along is dashed, an edge it went along is solid, and the edge into the
 * running step has flowing dashes.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RunGraph } from "@hercule/client-core";
import { RunGraphView } from "./run-graph-view";

/** The class that makes an edge's dashes flow, from the shared stylesheet. */
const FLOW_CLASS = "hercule-edge-flow";

/**
 * A running run: `create` has completed and led to `start`, which is running
 * now, and `start` has not led to `finish` yet.
 */
const RUN_GRAPH: RunGraph = {
  status: "running",
  nodes: [
    { id: "create", kind: "action", progress: { state: "completed" } },
    { id: "start", kind: "action", progress: { state: "running" } },
    { id: "finish", kind: "action", progress: { state: "unreached" } },
    { id: "check", kind: "action", progress: { state: "completed" } },
  ],
  edges: [
    { from: "create", to: "start", travel: "active" },
    { from: "start", to: "finish", travel: "untravelled" },
    { from: "create", to: "check", travel: "travelled" },
  ],
};

/** Returns the drawn curve of the edge from `from` to `to`. */
const getEdgeCurve = (from: string, to: string): SVGPathElement => {
  const edge = screen.getByRole("img", { name: `Edge from ${from} to ${to}` });
  const curve = edge.querySelector<SVGPathElement>("path.react-flow__edge-path");
  if (curve === null) throw new Error(`the edge from ${from} to ${to} has no curve`);
  return curve;
};

describe("RunGraphView > edges", () => {
  it("draws an untravelled edge dashed, a travelled edge solid, and the active edge flowing", () => {
    render(
      <div style={{ width: 800, height: 260 }}>
        <RunGraphView runGraph={RUN_GRAPH} now={Date.now()} />
      </div>,
    );

    const untravelled = getEdgeCurve("start", "finish");
    expect(untravelled.style.strokeDasharray).not.toBe("");
    expect(untravelled.classList.contains(FLOW_CLASS)).toBe(false);

    const travelled = getEdgeCurve("create", "check");
    expect(travelled.style.strokeDasharray).toBe("");
    expect(travelled.classList.contains(FLOW_CLASS)).toBe(false);

    const active = getEdgeCurve("create", "start");
    expect(active.classList.contains(FLOW_CLASS)).toBe(true);
  });
});
