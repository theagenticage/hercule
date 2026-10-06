/**
 * Tests `buildSubagentTree`, `listSubagentAncestors` and
 * `listSubagentDescendants`, which arrange a session's subagents by who
 * started whom.
 */
import { describe, expect, it } from "vitest";
import type { Subagent } from "@hercule/contract";
import { buildSubagent } from "./subagents.testing";
import {
  buildSubagentTree,
  listSubagentAncestors,
  listSubagentDescendants,
  type SubagentNode,
} from "./tree";

// Three levels under the main agent, listed out of start order:
//
// - a (09:00)
//   - a2 (09:03)
//   - a1 (09:02)
//     - a1x (09:04)
// - b (09:01)
const A = buildSubagent({ id: "a", startedAt: "2026-10-05T09:00:00.000Z" });
const B = buildSubagent({ id: "b", startedAt: "2026-10-05T09:01:00.000Z" });
const A1 = buildSubagent({
  id: "a1",
  parentSubagentId: "a",
  startedAt: "2026-10-05T09:02:00.000Z",
});
const A2 = buildSubagent({
  id: "a2",
  parentSubagentId: "a",
  startedAt: "2026-10-05T09:03:00.000Z",
});
const A1X = buildSubagent({
  id: "a1x",
  parentSubagentId: "a1",
  startedAt: "2026-10-05T09:04:00.000Z",
});
const ALL: readonly Subagent[] = [A2, B, A1X, A1, A];

/** Returns the tree as nested ids, which reads more easily in a failure. */
const readIds = (nodes: readonly SubagentNode[]): unknown[] =>
  nodes.map((node) =>
    node.children.length === 0 ? node.subagent.id : [node.subagent.id, readIds(node.children)],
  );

describe("buildSubagentTree", () => {
  it("nests each subagent under the one that started it, siblings oldest first", () => {
    expect(readIds(buildSubagentTree(ALL))).toEqual([["a", [["a1", ["a1x"]], "a2"]], "b"]);
  });

  it("makes a subagent whose parent is not in the list a root, so it is never left out", () => {
    expect(readIds(buildSubagentTree([A1X, B]))).toEqual(["b", "a1x"]);
  });

  it("breaks a tie in start time by id, as the controller lists them", () => {
    const at = "2026-10-05T09:00:00.000Z";
    const tree = buildSubagentTree([
      buildSubagent({ id: "c", startedAt: at }),
      buildSubagent({ id: "a", startedAt: at }),
      buildSubagent({ id: "b", startedAt: at }),
    ]);
    expect(tree.map((node) => node.subagent.id)).toEqual(["a", "b", "c"]);
  });

  it("returns no roots for no subagents", () => {
    expect(buildSubagentTree([])).toEqual([]);
  });
});

describe("listSubagentAncestors", () => {
  it("lists the subagents above it, the outermost first, without itself", () => {
    expect(listSubagentAncestors(A1X, ALL).map((each) => each.id)).toEqual(["a", "a1"]);
  });

  it("returns an empty list for a subagent the main agent started", () => {
    expect(listSubagentAncestors(A, ALL)).toEqual([]);
  });
});

describe("listSubagentDescendants", () => {
  it("lists every subagent below it, at any depth, in tree order", () => {
    expect(listSubagentDescendants(A, ALL).map((each) => each.id)).toEqual(["a1", "a1x", "a2"]);
  });

  it("returns an empty list for a subagent that started none", () => {
    expect(listSubagentDescendants(B, ALL)).toEqual([]);
  });
});
