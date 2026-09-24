import { assert, describe, it } from "vitest";
import {
  describeFailureReason,
  describeRunOrigin,
  describeRunStatus,
  describeStepState,
  formatElapsed,
  measureElapsed,
  shouldRunRecede,
} from "./run-display";

const PARENT = "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e";
const START = "2026-09-24T12:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();
const NOW = Date.parse(START) + 4_300;

describe("describeRunOrigin", () => {
  it("names who started the run, and how when not by hand", () => {
    const manual = describeRunOrigin({ kind: "manual", actor: "user" });
    assert.strictEqual(manual.starter.label, "you");
    assert.strictEqual(manual.channel, undefined);

    const api = describeRunOrigin({ kind: "api", actor: `session:${PARENT}` });
    assert.strictEqual(api.starter.label, "session 1f3a9c2e");
    assert.strictEqual(api.channel, "through the API");

    const child = describeRunOrigin({ kind: "action", parentRunId: PARENT, stepId: "spawn" });
    assert.strictEqual(child.starter.label, "run 1f3a9c2e");
    assert.strictEqual(child.starter.runId, PARENT);
    assert.strictEqual(child.channel, "at step spawn");
  });
});

describe("shouldRunRecede", () => {
  it("lets completed and cancelled runs recede, and keeps live and failed runs forward", () => {
    assert.deepStrictEqual(
      (["pending", "running", "completed", "failed", "cancelled"] as const).map(shouldRunRecede),
      [false, false, true, false, true],
    );
  });
});

describe("measureElapsed", () => {
  it("measures to the end, or to now while unfinished, and nothing before the start", () => {
    assert.strictEqual(measureElapsed(START, at(12), NOW), 12);
    assert.strictEqual(measureElapsed(START, undefined, NOW), 4_300);
    assert.strictEqual(measureElapsed(undefined, undefined, NOW), undefined);
  });
});

describe("formatElapsed", () => {
  it("shows milliseconds below a second, tenths below a minute, and minutes above", () => {
    assert.strictEqual(formatElapsed(0), "0ms");
    assert.strictEqual(formatElapsed(12.9), "12ms");
    assert.strictEqual(formatElapsed(1_000), "1.0s");
    // Rounded down, so a ticking duration never shows a tenth that has not passed.
    assert.strictEqual(formatElapsed(4_390), "4.3s");
    assert.strictEqual(formatElapsed(64_000), "1m 4s");
    assert.strictEqual(formatElapsed(64_900), "1m 4s");
  });
});

describe("describeRunStatus", () => {
  it("adds the duration to every status but pending", () => {
    assert.strictEqual(describeRunStatus({ status: "pending" }, NOW), "pending");
    assert.strictEqual(
      describeRunStatus({ status: "running", startedAt: START }, NOW),
      "running 4.3s",
    );
    assert.strictEqual(
      describeRunStatus({ status: "completed", startedAt: START, finishedAt: at(23) }, NOW),
      "completed in 23ms",
    );
    assert.strictEqual(
      describeRunStatus({ status: "failed", startedAt: START, finishedAt: at(1_200) }, NOW),
      "failed after 1.2s",
    );
  });

  it("shows a run cancelled before it started without a duration", () => {
    assert.strictEqual(
      describeRunStatus({ status: "cancelled", finishedAt: at(5) }, NOW),
      "cancelled",
    );
  });
});

describe("describeFailureReason", () => {
  it("says each reason in plain words", () => {
    assert.strictEqual(describeFailureReason("step-failed"), "step failed");
    assert.strictEqual(describeFailureReason("expression-error"), "template error");
  });
});

describe("describeStepState", () => {
  it("uses the contract's words, and tells a step not yet started from one never reached", () => {
    assert.strictEqual(describeStepState("pending", "running"), "pending");
    assert.strictEqual(describeStepState("completed", "completed"), "completed");
    assert.strictEqual(describeStepState("unreached", "running"), "not started");
    assert.strictEqual(describeStepState("unreached", "failed"), "not reached");
  });
});
