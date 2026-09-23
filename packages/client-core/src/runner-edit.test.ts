import { describe, expect, it } from "vitest";
import type { Runner } from "@hercule/contract";
import { ApiError } from "./errors";
import {
  buildRetireQuestion,
  findRunnerConflictField,
  buildRunnerDraft,
  buildRunnerPatch,
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
const buildTypedDraft = (into: Partial<RunnerDraft>): RunnerDraft => ({
  ...buildRunnerDraft(RUNNER),
  ...into,
});

describe("buildRunnerPatch", () => {
  it("says nothing when nothing moved", () => {
    expect(buildRunnerPatch(RUNNER, buildRunnerDraft(RUNNER))).toEqual({});
  });

  it("carries only the fields the draft moved", () => {
    const draft = buildTypedDraft({ name: "moss-2", reserved: true });
    expect(buildRunnerPatch(RUNNER, draft)).toEqual({ name: "moss-2", reserved: true });
  });

  it("reads labels by their order, so a reordering is a change", () => {
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ labels: ["gpu", "primary"] }))).toEqual({});
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ labels: ["primary", "gpu"] }))).toEqual({
      labels: ["primary", "gpu"],
    });
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ labels: [] }))).toEqual({ labels: [] });
  });

  it("trims a name, so padding one is not a change", () => {
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ name: "  moss  " }))).toEqual({});
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ name: "  moss-2 " }))).toEqual({
      name: "moss-2",
    });
  });

  it("reads an emptied name as a change, so nothing refills the field behind the user", () => {
    // The form refuses to submit it; what matters here is that the draft is not
    // mistaken for an untouched one.
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ name: "" }))).toEqual({ name: "" });
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ name: "   " }))).toEqual({ name: "" });
  });

  it("sends a cap the controller will refuse rather than swallowing it", () => {
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ maxConcurrentSessions: 0 }))).toEqual({
      maxConcurrentSessions: 0,
    });
  });

  it("carries a moved disk watermark, in bytes", () => {
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ diskWatermarkBytes: 2 * GIB }))).toEqual({
      diskWatermarkBytes: 2 * GIB,
    });
  });

  it("sends an emptied disk watermark the controller will refuse rather than swallowing it", () => {
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ diskWatermarkBytes: 0 }))).toEqual({
      diskWatermarkBytes: 0,
    });
  });
});

describe("findRunnerConflictField", () => {
  const conflict = new ApiError("conflict", "another runner already has that name");

  it("blames the one field of the two the patch moved", () => {
    expect(findRunnerConflictField(conflict, { name: "moss" })).toBe("name");
    expect(findRunnerConflictField(conflict, { reserved: true })).toBe("reserved");
    expect(findRunnerConflictField(conflict, { name: "moss", labels: [] })).toBe("name");
  });

  it("blames no field when either of the two could have been refused", () => {
    expect(findRunnerConflictField(conflict, { name: "moss", reserved: true })).toBeNull();
  });

  it("blames no field for anything that is not a conflict", () => {
    expect(findRunnerConflictField(null, { name: "moss" })).toBeNull();
    expect(
      findRunnerConflictField(new ApiError("validation", "too long"), { name: "" }),
    ).toBeNull();
    expect(findRunnerConflictField(new Error("offline"), { name: "moss" })).toBeNull();
  });
});

describe("buildRetireQuestion", () => {
  it("asks plainly when nothing is at stake beyond the machine itself", () => {
    expect(buildRetireQuestion(RUNNER, null)).toEqual({ warnings: [], force: false });
  });

  it("says a machine it cannot reach is being forced, and forces it", () => {
    expect(buildRetireQuestion({ ...RUNNER, connectivity: "unreachable" }, null)).toEqual({
      warnings: ["This runner is unreachable; retiring it now forces it."],
      force: true,
    });
  });

  it("says the fleet is about to lose its default", () => {
    expect(buildRetireQuestion(RUNNER, RUNNER.id)).toEqual({
      warnings: ["This is the default runner; the fleet will have no default."],
      force: false,
    });
  });

  it("says both, reachability first", () => {
    const question = buildRetireQuestion({ ...RUNNER, connectivity: "unreachable" }, RUNNER.id);
    expect(question.warnings).toEqual([
      "This runner is unreachable; retiring it now forces it.",
      "This is the default runner; the fleet will have no default.",
    ]);
    expect(question.force).toBe(true);
  });

  it("says nothing about a default that is another machine", () => {
    expect(buildRetireQuestion(RUNNER, "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb").warnings).toEqual(
      [],
    );
  });
});
