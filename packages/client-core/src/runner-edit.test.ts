import { describe, expect, it } from "vitest";
import type { Runner } from "@hercule/contract";
import { ApiError } from "./errors";
import {
  retireQuestion,
  runnerConflictField,
  runnerDraft,
  runnerPatch,
  type RunnerDraft,
} from "./runner-edit";

const GIB = 1024 * 1024 * 1024;

const RUNNER: Runner = {
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "moss",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.4.2",
  labels: ["gpu", "primary"],
  facts: null,
  watermark: null,
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: null,
};

/** The form as it opens on the runner above, with something typed into it. */
const typed = (into: Partial<RunnerDraft>): RunnerDraft => ({ ...runnerDraft(RUNNER), ...into });

describe("runnerPatch", () => {
  it("says nothing when nothing moved", () => {
    expect(runnerPatch(RUNNER, runnerDraft(RUNNER))).toEqual({});
  });

  it("carries only the fields the draft moved", () => {
    const draft = typed({ name: "moss-2", reserved: true });
    expect(runnerPatch(RUNNER, draft)).toEqual({ name: "moss-2", reserved: true });
  });

  it("reads labels by their order, so a reordering is a change", () => {
    expect(runnerPatch(RUNNER, typed({ labels: ["gpu", "primary"] }))).toEqual({});
    expect(runnerPatch(RUNNER, typed({ labels: ["primary", "gpu"] }))).toEqual({
      labels: ["primary", "gpu"],
    });
    expect(runnerPatch(RUNNER, typed({ labels: [] }))).toEqual({ labels: [] });
  });

  it("trims a name, so padding one is not a change", () => {
    expect(runnerPatch(RUNNER, typed({ name: "  moss  " }))).toEqual({});
    expect(runnerPatch(RUNNER, typed({ name: "  moss-2 " }))).toEqual({
      name: "moss-2",
    });
  });

  it("reads an emptied name as a change, so nothing refills the field behind the user", () => {
    // The form refuses to submit it; what matters here is that the draft is not
    // mistaken for an untouched one.
    expect(runnerPatch(RUNNER, typed({ name: "" }))).toEqual({ name: "" });
    expect(runnerPatch(RUNNER, typed({ name: "   " }))).toEqual({ name: "" });
  });

  it("sends a cap the controller will refuse rather than swallowing it", () => {
    expect(runnerPatch(RUNNER, typed({ maxConcurrentSessions: 0 }))).toEqual({
      maxConcurrentSessions: 0,
    });
  });

  it("carries a moved disk watermark, in bytes", () => {
    expect(runnerPatch(RUNNER, typed({ diskWatermarkBytes: 2 * GIB }))).toEqual({
      diskWatermarkBytes: 2 * GIB,
    });
  });

  it("sends an emptied disk watermark the controller will refuse rather than swallowing it", () => {
    expect(runnerPatch(RUNNER, typed({ diskWatermarkBytes: 0 }))).toEqual({
      diskWatermarkBytes: 0,
    });
  });
});

describe("runnerConflictField", () => {
  const conflict = new ApiError("conflict", "another runner already has that name");

  it("blames the one field of the two the patch moved", () => {
    expect(runnerConflictField(conflict, { name: "moss" })).toBe("name");
    expect(runnerConflictField(conflict, { reserved: true })).toBe("reserved");
    expect(runnerConflictField(conflict, { name: "moss", labels: [] })).toBe("name");
  });

  it("blames no field when either of the two could have been refused", () => {
    expect(runnerConflictField(conflict, { name: "moss", reserved: true })).toBeNull();
  });

  it("blames no field for anything that is not a conflict", () => {
    expect(runnerConflictField(null, { name: "moss" })).toBeNull();
    expect(runnerConflictField(new ApiError("validation", "too long"), { name: "" })).toBeNull();
    expect(runnerConflictField(new Error("offline"), { name: "moss" })).toBeNull();
  });
});

describe("retireQuestion", () => {
  it("asks plainly when nothing is at stake beyond the machine itself", () => {
    expect(retireQuestion(RUNNER, null)).toEqual({ warnings: [], force: false });
  });

  it("says a machine it cannot reach is being forced, and forces it", () => {
    expect(retireQuestion({ ...RUNNER, connectivity: "unreachable" }, null)).toEqual({
      warnings: ["This runner is unreachable; retiring it now forces it."],
      force: true,
    });
  });

  it("says the fleet is about to lose its default", () => {
    expect(retireQuestion(RUNNER, RUNNER.id)).toEqual({
      warnings: ["This is the default runner; the fleet will have no default."],
      force: false,
    });
  });

  it("says both, reachability first", () => {
    const question = retireQuestion({ ...RUNNER, connectivity: "unreachable" }, RUNNER.id);
    expect(question.warnings).toEqual([
      "This runner is unreachable; retiring it now forces it.",
      "This is the default runner; the fleet will have no default.",
    ]);
    expect(question.force).toBe(true);
  });

  it("says nothing about a default that is another machine", () => {
    expect(retireQuestion(RUNNER, "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb").warnings).toEqual([]);
  });
});
