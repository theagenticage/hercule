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

/** Returns the form's draft for the runner above, with the fields in `into` changed. */
const buildTypedDraft = (into: Partial<RunnerDraft>): RunnerDraft => ({
  ...buildRunnerDraft(RUNNER),
  ...into,
});

describe("buildRunnerPatch", () => {
  it("returns an empty patch when nothing changed", () => {
    expect(buildRunnerPatch(RUNNER, buildRunnerDraft(RUNNER))).toEqual({});
  });

  it("includes only the fields the draft changed", () => {
    const draft = buildTypedDraft({ name: "moss-2", reserved: true });
    expect(buildRunnerPatch(RUNNER, draft)).toEqual({ name: "moss-2", reserved: true });
  });

  it("compares labels in order, so reordering them is a change", () => {
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ labels: ["gpu", "primary"] }))).toEqual({});
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ labels: ["primary", "gpu"] }))).toEqual({
      labels: ["primary", "gpu"],
    });
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ labels: [] }))).toEqual({ labels: [] });
  });

  it("trims the name, so added spaces are not a change", () => {
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ name: "  moss  " }))).toEqual({});
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ name: "  moss-2 " }))).toEqual({
      name: "moss-2",
    });
  });

  it("treats a cleared name as a change, so a refresh does not refill the field", () => {
    // The form does not submit an empty name. What matters here is that the
    // draft is not mistaken for an untouched one.
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ name: "" }))).toEqual({ name: "" });
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ name: "   " }))).toEqual({ name: "" });
  });

  it("sends a maximum the controller will reject rather than dropping it", () => {
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ maxConcurrentSessions: 0 }))).toEqual({
      maxConcurrentSessions: 0,
    });
  });

  it("includes a changed disk watermark, in bytes", () => {
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ diskWatermarkBytes: 2 * GIB }))).toEqual({
      diskWatermarkBytes: 2 * GIB,
    });
  });

  it("sends a zero disk watermark the controller will reject rather than dropping it", () => {
    expect(buildRunnerPatch(RUNNER, buildTypedDraft({ diskWatermarkBytes: 0 }))).toEqual({
      diskWatermarkBytes: 0,
    });
  });
});

describe("findRunnerConflictField", () => {
  const conflict = new ApiError("conflict", "another runner already has that name");

  it("returns the one of the two fields that the patch changed", () => {
    expect(findRunnerConflictField(conflict, { name: "moss" })).toBe("name");
    expect(findRunnerConflictField(conflict, { reserved: true })).toBe("reserved");
    expect(findRunnerConflictField(conflict, { name: "moss", labels: [] })).toBe("name");
  });

  it("returns null when the patch changed both fields", () => {
    expect(findRunnerConflictField(conflict, { name: "moss", reserved: true })).toBeNull();
  });

  it("returns null for any error that is not a conflict", () => {
    expect(findRunnerConflictField(null, { name: "moss" })).toBeNull();
    expect(
      findRunnerConflictField(new ApiError("validation", "too long"), { name: "" }),
    ).toBeNull();
    expect(findRunnerConflictField(new Error("offline"), { name: "moss" })).toBeNull();
  });
});

describe("buildRetireQuestion", () => {
  it("has no warnings for an online runner that is not the default", () => {
    expect(buildRetireQuestion(RUNNER, null)).toEqual({ warnings: [], force: false });
  });

  it("warns that an unreachable runner is forced, and forces it", () => {
    expect(buildRetireQuestion({ ...RUNNER, connectivity: "unreachable" }, null)).toEqual({
      warnings: ["This runner is unreachable; retiring it now forces it."],
      force: true,
    });
  });

  it("warns that the fleet will lose its default runner", () => {
    expect(buildRetireQuestion(RUNNER, RUNNER.id)).toEqual({
      warnings: ["This is the default runner; the fleet will have no default."],
      force: false,
    });
  });

  it("gives both warnings, the unreachable one first", () => {
    const question = buildRetireQuestion({ ...RUNNER, connectivity: "unreachable" }, RUNNER.id);
    expect(question.warnings).toEqual([
      "This runner is unreachable; retiring it now forces it.",
      "This is the default runner; the fleet will have no default.",
    ]);
    expect(question.force).toBe(true);
  });

  it("does not warn when another runner is the default", () => {
    expect(buildRetireQuestion(RUNNER, "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb").warnings).toEqual(
      [],
    );
  });
});
