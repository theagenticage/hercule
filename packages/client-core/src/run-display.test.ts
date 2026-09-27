import { assert, describe, it } from "vitest";
import type { Run, Runner, StepRecord } from "@hercule/contract";
import {
  describeFailureReason,
  findFailedEdge,
  describeRunOrigin,
  describeRunnerWait,
  describeRunStatus,
  describeStepDuration,
  describeStepState,
  describeUnstartedStep,
  formatElapsed,
  measureElapsed,
  readTimestamps,
  shouldRunRecede,
} from "./run-display";
import { buildRunner } from "./threads/workspaces.testing";

const PARENT = "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e";
const START = "2026-09-24T12:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();
const NOW = Date.parse(START) + 4_300;

describe("describeRunOrigin", () => {
  it("names who started the run, and how when not by hand", () => {
    const manual = describeRunOrigin({ kind: "manual", actor: "user" });
    assert.strictEqual(manual.starter.label, "you");
    assert.strictEqual(manual.howStarted, undefined);

    const api = describeRunOrigin({ kind: "api", actor: `session:${PARENT}` });
    assert.strictEqual(api.starter.label, "session 1f3a9c2e");
    assert.strictEqual(api.howStarted, "through the API");

    const child = describeRunOrigin({ kind: "action", parentRunId: PARENT, stepId: "spawn" });
    assert.strictEqual(child.starter.label, "run 1f3a9c2e");
    assert.deepStrictEqual(child.starter.link, { kind: "run", runId: PARENT });
    assert.strictEqual(child.howStarted, "at step spawn");
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

describe("readTimestamps", () => {
  it("reads the times each status has, and leaves out the ones it does not", () => {
    const base = { stepId: "a", iteration: 1 };
    assert.deepStrictEqual(readTimestamps({ ...base, status: "pending" }), {});
    assert.deepStrictEqual(readTimestamps({ ...base, status: "running", startedAt: START }), {
      startedAt: START,
    });
    const completed: StepRecord = {
      ...base,
      status: "completed",
      startedAt: START,
      finishedAt: at(40),
      output: null,
    };
    assert.deepStrictEqual(readTimestamps(completed), { startedAt: START, finishedAt: at(40) });
    assert.deepStrictEqual(readTimestamps({ ...base, status: "cancelled", finishedAt: at(5) }), {
      finishedAt: at(5),
    });
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

describe("describeStepDuration", () => {
  it("measures a record to its end, or to now while it runs, and is empty before it starts", () => {
    assert.strictEqual(describeStepDuration({ startedAt: START, finishedAt: at(40) }, NOW), "40ms");
    assert.strictEqual(
      describeStepDuration({ startedAt: START, finishedAt: at(75_000) }, NOW),
      "1m 15s",
    );
    assert.strictEqual(describeStepDuration({ startedAt: START }, NOW), "4.3s");
    assert.strictEqual(describeStepDuration({}, NOW), "");
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
  it("describes each reason in plain words", () => {
    assert.strictEqual(describeFailureReason("step-failed"), "step failed");
    assert.strictEqual(describeFailureReason("expression-error"), "expression error");
    assert.strictEqual(describeFailureReason("controller-error"), "controller error");
    assert.strictEqual(describeFailureReason("iteration-limit"), "iteration limit");
  });

  it("does not call an expression error a template error, because a condition fails with it too", () => {
    assert.notMatch(describeFailureReason("expression-error"), /template/);
  });
});

describe("findFailedEdge", () => {
  /** A loop: `file` leads to `count`, and `count` back to `file` at most 3 times, or on to `escalate`. */
  const BASE = {
    id: PARENT,
    workflowId: null,
    plan: {
      name: "File a batch",
      steps: [
        { id: "file", kind: "action", action: "task.create" },
        { id: "count", kind: "action", action: "task.query" },
        { id: "escalate", kind: "action", action: "task.update" },
      ],
      edges: [
        { from: "file", to: "count" },
        { from: "count", to: "file", condition: "steps.count.output.more", maxTraversals: 3 },
        { from: "count", to: "escalate", condition: "!steps.count.output.more" },
      ],
    },
    inputs: {},
    origin: { kind: "manual", actor: "user" },
    steps: [],
    edgeTraversals: [4, 3, 0],
    createdAt: START,
    startedAt: START,
    finishedAt: at(100),
  } as const;
  const FAILED: Run = {
    ...BASE,
    status: "failed",
    failureReason: "iteration-limit",
    failedStepId: "count",
    failedEdge: { index: 1, message: "The edge ran out." },
  };

  it("finds the edge a run failed at, by its index in the plan", () => {
    const limit = findFailedEdge(FAILED);
    assert.deepStrictEqual([limit?.from, limit?.to], ["count", "file"]);
    const condition = findFailedEdge({
      ...BASE,
      status: "failed",
      failureReason: "expression-error",
      failedStepId: "count",
      failedEdge: { index: 2, message: "The condition could not be evaluated." },
    });
    assert.deepStrictEqual([condition?.from, condition?.to], ["count", "escalate"]);
  });

  it("finds no edge for a run that failed at a step, or did not fail", () => {
    assert.strictEqual(
      findFailedEdge({
        ...BASE,
        status: "failed",
        failureReason: "step-failed",
        failedStepId: "file",
      }),
      undefined,
    );
    assert.strictEqual(findFailedEdge({ ...BASE, status: "completed" }), undefined);
  });
});

describe("describeUnstartedStep", () => {
  it("describes why a step has no bar, for a pending, a cancelled, a skipped and a never reached step", () => {
    assert.strictEqual(describeUnstartedStep("pending", "running"), "pending");
    assert.strictEqual(
      describeUnstartedStep("cancelled", "cancelled"),
      "cancelled before it started",
    );
    assert.strictEqual(describeUnstartedStep("skipped", "completed"), "skipped");
    assert.strictEqual(describeUnstartedStep("unreached", "completed"), "not reached");
    assert.strictEqual(describeUnstartedStep("completed", "completed"), undefined);
  });

  it("says nothing of a step a live run has not reached yet, because the run may still reach it", () => {
    assert.strictEqual(describeUnstartedStep("unreached", "running"), undefined);
  });
});

describe("describeStepState", () => {
  it("uses the contract's words, and tells apart a step not yet started and one never reached", () => {
    assert.strictEqual(describeStepState("pending", "running"), "pending");
    assert.strictEqual(describeStepState("completed", "completed"), "completed");
    assert.strictEqual(describeStepState("unreached", "running"), "not started");
    assert.strictEqual(describeStepState("unreached", "failed"), "not reached");
  });
});

describe("describeRunnerWait", () => {
  const RUNNER_ID = "01a06d02-c111-7a0e-8b3d-9c1f00000001";
  /** Last seen at 14:02 in Amsterdam. */
  const OFFLINE: Runner = {
    ...buildRunner(RUNNER_ID, "mac-mini"),
    connectivity: "offline",
    lastSeenAt: "2026-09-24T12:02:00.000Z",
  };
  const ACTIONS = [
    { id: "git.commit", runsIn: "workspace" },
    { id: "task.query", runsIn: "controller" },
  ] as const;
  /**
   * A run pinned to no runner yet, with two steps running: `commit`, which
   * runs in the workspace, and `note`, which runs on the controller.
   */
  const UNPINNED: Run = {
    id: PARENT,
    workflowId: null,
    plan: {
      name: "Commit the fix",
      steps: [
        { id: "commit", kind: "action", action: "git.commit" },
        { id: "note", kind: "action", action: "task.query" },
      ],
    },
    inputs: {},
    origin: { kind: "manual", actor: "user" },
    steps: [
      { stepId: "commit", iteration: 1, status: "running", startedAt: START },
      { stepId: "note", iteration: 1, status: "running", startedAt: START },
    ],
    edgeTraversals: [],
    createdAt: START,
    status: "running",
    startedAt: START,
  };
  const PINNED: Run = { ...UNPINNED, runnerId: RUNNER_ID };

  it("names the running workspace steps, the runner they wait for, and since when, in the user's timezone", () => {
    assert.deepStrictEqual(describeRunnerWait(PINNED, OFFLINE, ACTIONS, "Europe/Amsterdam"), {
      stepIds: new Set(["commit"]),
      text: "Waiting for runner mac-mini to reconnect (offline since 24 Sep 14:02)",
    });
    assert.strictEqual(
      describeRunnerWait(PINNED, { ...OFFLINE, connectivity: "unreachable" }, ACTIONS, "UTC")?.text,
      "Waiting for runner mac-mini to reconnect (offline since 24 Sep 12:02)",
    );
    assert.strictEqual(
      describeRunnerWait(PINNED, { ...OFFLINE, lastSeenAt: null }, ACTIONS, "UTC")?.text,
      "Waiting for runner mac-mini to reconnect",
    );
  });

  it("names the plan's workspace actions under a pending workspace step of a run no runner has taken yet", () => {
    const waiting: Run = {
      ...UNPINNED,
      plan: {
        ...UNPINNED.plan,
        steps: [...UNPINNED.plan.steps, { id: "push", kind: "action", action: "git.push" }],
      },
      steps: [
        { stepId: "commit", iteration: 1, status: "pending" },
        { stepId: "note", iteration: 1, status: "pending" },
      ],
    };
    const actions = [...ACTIONS, { id: "git.push", runsIn: "workspace" }] as const;
    assert.deepStrictEqual(describeRunnerWait(waiting, undefined, actions, "UTC"), {
      stepIds: new Set(["commit"]),
      text: "Waiting for a runner that can run git.commit and git.push",
    });
    // Once a runner has taken the run, its pending steps no longer wait.
    assert.strictEqual(
      describeRunnerWait({ ...waiting, runnerId: RUNNER_ID }, OFFLINE, actions, "UTC"),
      undefined,
    );
  });

  it("says nothing when no step waits for a runner", () => {
    const noteOnly: Run = {
      ...PINNED,
      steps: [{ stepId: "note", iteration: 1, status: "running", startedAt: START }],
    };
    const cases: ReadonlyArray<readonly [Run, Runner | undefined]> = [
      [PINNED, { ...OFFLINE, connectivity: "online" }],
      [PINNED, undefined],
      [UNPINNED, OFFLINE],
      [PINNED, { ...OFFLINE, id: PARENT }],
      // Only a step that runs on the controller is running.
      [noteOnly, OFFLINE],
      [{ ...PINNED, status: "cancelled", finishedAt: at(10) }, OFFLINE],
    ];
    for (const [run, runner] of cases) {
      assert.strictEqual(describeRunnerWait(run, runner, ACTIONS, "UTC"), undefined);
    }
    // An action missing from the catalog is not taken to run in the workspace.
    assert.strictEqual(describeRunnerWait(PINNED, OFFLINE, [], "UTC"), undefined);
  });
});
