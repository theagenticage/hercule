/**
 * Tests the walk along a workflow's edges that the controller and the run
 * graph both use to find the steps a set of steps can lead to.
 */
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { collectReachableSteps, WorkspacePolicy } from "./workflow-definition";
import { decodeWorkflowDefinition } from "./workflow-definition-decode";

describe("collecting the steps reachable from some steps", () => {
  it("includes the starting steps and every step a path of edges leads to", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "x", to: "y" },
    ];
    expect([...collectReachableSteps(edges, ["a"])].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns only the starting steps when no edge leaves them", () => {
    expect([...collectReachableSteps([{ from: "a", to: "b" }], ["b", "z"])].sort()).toEqual([
      "b",
      "z",
    ]);
  });

  it("stops at a loop instead of walking it forever", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "b", to: "c" },
    ];
    expect([...collectReachableSteps(edges, ["b"])].sort()).toEqual(["a", "b", "c"]);
  });

  it("follows every edge, whatever its condition or limit", () => {
    const edges = [
      { from: "a", to: "b", condition: "${{ false }}", maxTraversals: 1 },
      { from: "b", to: "c", maxTraversals: 0 },
    ];
    expect([...collectReachableSteps(edges, ["a"])].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns an empty set when it starts from no step", () => {
    expect(collectReachableSteps([{ from: "a", to: "b" }], []).size).toBe(0);
  });
});

describe("starting revisions in workflow workspace policies", () => {
  const resourceId = "0199e0e7-1111-7000-8000-000000000002";
  const policy = (checkout: object) => ({
    kind: "ephemeral",
    checkouts: [{ resourceId, ...checkout }],
  });

  it("preserves explicit current, local and remote choices and existing omitted/deprecated policies", () => {
    for (const checkout of [
      {},
      { baseBranch: "release/2.1" },
      { startingRevision: { kind: "current" } },
      { startingRevision: { kind: "local", branch: "feature/local-only" } },
      { startingRevision: { kind: "remote", branch: "release/2.1" } },
      { startingRevision: { kind: "remote" } },
    ]) {
      const input = policy(checkout);
      expect(Schema.decodeUnknownSync(WorkspacePolicy)(input)).toEqual(input);
    }
  });

  it("refuses invalid and option-like branches for local and remote choices", () => {
    for (const kind of ["local", "remote"]) {
      for (const branch of [
        "",
        "--upload-pack=id",
        "feature..other",
        "feature\nother",
        "feature\u0000other",
        "feature@{1}",
        "feature.lock",
      ]) {
        expect(
          Schema.decodeUnknownExit(WorkspacePolicy)(policy({ startingRevision: { kind, branch } }))
            ._tag,
          `${kind}: ${JSON.stringify(branch)}`,
        ).toBe("Failure");
      }
    }
  });

  it("refuses both fields instead of choosing between incompatible revision instructions", () => {
    for (const startingRevision of [
      { kind: "current" },
      { kind: "local", branch: "main" },
      { kind: "remote", branch: "main" },
      { kind: "remote" },
    ]) {
      expect(
        Schema.decodeUnknownExit(WorkspacePolicy)(policy({ baseBranch: "main", startingRevision }))
          ._tag,
      ).toBe("Failure");
    }
  });
});

describe("a workflow input that takes an entity", () => {
  const define = (input: Record<string, unknown>) =>
    decodeWorkflowDefinition({
      name: "Review",
      inputs: [{ name: "pull_request", required: true, ...input }],
      steps: [{ id: "start", kind: "action", action: "task.create" }],
    });

  it("accepts qualified entity kinds and the signal kinds it answers", () => {
    const result = define({
      entity: { kinds: ["github/pull-request"], answers: ["github/review-requested"] },
    });
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("accepts entity kinds with no answers", () => {
    expect(Result.isSuccess(define({ entity: { kinds: ["github/pull-request"] } }))).toBe(true);
  });

  it("refuses an empty list of kinds, an unqualified kind and an empty list of answers", () => {
    for (const entity of [
      { kinds: [] },
      { kinds: ["pull-request"] },
      { kinds: ["github/pull-request"], answers: [] },
    ]) {
      expect(Result.isFailure(define({ entity })), JSON.stringify(entity)).toBe(true);
    }
  });

  it("refuses an input that sets an entity and another type", () => {
    const result = define({
      entity: { kinds: ["github/pull-request"] },
      signal: { kinds: ["fyi"] },
    });
    expect(Result.isFailure(result)).toBe(true);
  });
});
