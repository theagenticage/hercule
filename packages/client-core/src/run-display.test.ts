import { assert, describe, it } from "vitest";
import type { Run, Runner, StepRecord } from "@hercule/contract";
import {
  describeFailureReason,
  findFailedEdge,
  findStepLineKind,
  describeRunOrigin,
  describeReruns,
  describeRunnerWait,
  describeRunStatus,
  describeStepDuration,
  describeStepSession,
  describeStepState,
  describeUnstartedStep,
  formatElapsed,
  listAwaitedSignals,
  listRerunChoices,
  measureElapsed,
  readTimestamps,
  shouldRunRecede,
} from "./run-display";
import { buildRunner, buildSession } from "./threads/workspaces.testing";

const PARENT = "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e";
const START = "2026-09-24T12:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();
const NOW = Date.parse(START) + 4_300;

describe("describeRunOrigin", () => {
  it("names who started the run, and how when not by hand", () => {
    assert.deepStrictEqual(describeRunOrigin({ origin: { kind: "manual", actor: "user" } }), {
      kind: "actor",
      label: "you",
      link: { kind: "none" },
      howStarted: undefined,
    });

    const api = describeRunOrigin({ origin: { kind: "api", actor: `session:${PARENT}` } });
    assert.strictEqual(api.label, "session 1f3a9c2e");
    assert.strictEqual(api.howStarted, "through the API");

    const child = describeRunOrigin({
      origin: { kind: "action", parentRunId: PARENT, stepId: "spawn" },
    });
    assert.deepStrictEqual(child, {
      kind: "actor",
      label: "run 1f3a9c2e",
      link: { kind: "run", runId: PARENT },
      howStarted: "at step spawn",
    });
  });

  it("names the trigger that started a run, and the kind of event it matched", () => {
    const origin = { kind: "trigger", triggerId: "on_issue", eventId: 42 } as const;
    assert.deepStrictEqual(
      describeRunOrigin({ origin, triggerEvent: { kind: "github.issue.opened" } }),
      {
        kind: "trigger",
        label: "trigger on_issue",
        triggerId: "on_issue",
        howStarted: "on github.issue.opened",
      },
    );
    // A run summary holds no copy of the event.
    const summary = describeRunOrigin({ origin });
    assert.strictEqual(summary.label, "trigger on_issue");
    assert.strictEqual(summary.howStarted, undefined);
  });
});

describe("listRerunChoices", () => {
  it("offers a stored workflow's run both modes, re-stamping from the current workflow first", () => {
    const choices = listRerunChoices({ workflowId: PARENT }, false);
    assert.deepStrictEqual(
      choices.map((choice) => [choice.mode, choice.label]),
      [
        ["re-stamp", "From the current workflow"],
        ["replay", "As it ran"],
      ],
    );
  });

  it("offers a run of a workflow that was never stored only a replay, and says why", () => {
    const choices = listRerunChoices({ workflowId: null }, false);
    assert.deepStrictEqual(
      choices.map((choice) => choice.mode),
      ["replay"],
    );
    assert.match(choices[0]?.explanation ?? "", /never saved/);
  });

  it("offers a run whose workflow was deleted only a replay, and says why", () => {
    const choices = listRerunChoices({ workflowId: PARENT }, true);
    assert.deepStrictEqual(
      choices.map((choice) => [choice.mode, choice.label]),
      [["replay", "As it ran"]],
    );
    assert.match(choices[0]?.explanation ?? "", /workflow was deleted/);
  });
});

describe("describeReruns", () => {
  const listIds = (count: number): ReadonlyArray<{ readonly id: string }> =>
    Array.from({ length: count }, (_, index) => ({ id: `run-${String(index + 1)}` }));

  it("links every re-run when there are three or fewer", () => {
    assert.deepStrictEqual(describeReruns({ items: [] }), {
      runIds: [],
      unlinkedCountText: undefined,
    });
    assert.deepStrictEqual(describeReruns({ items: listIds(3) }), {
      runIds: ["run-1", "run-2", "run-3"],
      unlinkedCountText: undefined,
    });
  });

  it("links the newest three, in the order the page lists them, and counts the rest", () => {
    assert.deepStrictEqual(describeReruns({ items: listIds(5) }), {
      runIds: ["run-1", "run-2", "run-3"],
      unlinkedCountText: "2 more",
    });
  });

  it("counts the rest as at least that many when the page has a next page", () => {
    assert.strictEqual(
      describeReruns({ items: listIds(50), nextCursor: "next" }).unlinkedCountText,
      "47+ more",
    );
  });

  it("says only that there are more when the page has a next page and every re-run on it is linked", () => {
    for (const count of [2, 3]) {
      assert.strictEqual(
        describeReruns({ items: listIds(count), nextCursor: "next" }).unlinkedCountText,
        "more",
      );
    }
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
    assert.strictEqual(
      describeStepDuration({ startedAt: START, finishedAt: at(40) }, "action", NOW),
      "40ms",
    );
    assert.strictEqual(
      describeStepDuration({ startedAt: START, finishedAt: at(75_000) }, "action", NOW),
      "1m 15s",
    );
    assert.strictEqual(describeStepDuration({ startedAt: START }, "agent", NOW), "4.3s");
    assert.strictEqual(describeStepDuration({}, "action", NOW), "");
  });

  it("is empty for a signal's record, which fires at one moment", () => {
    const fired = { startedAt: START, finishedAt: at(3) };
    assert.strictEqual(describeStepDuration(fired, "signal", NOW), "");
    assert.strictEqual(describeStepDuration(fired, "agent", NOW), "3ms");
  });
});

describe("findStepLineKind", () => {
  const plan: Pick<Run["plan"], "steps"> = {
    steps: [
      { id: "fetch", kind: "action", action: "http.request" },
      { id: "implement", kind: "agent", agent: "ada", prompt: "Fix it" },
    ],
  };

  it("returns the kind of the plan's step with the record's id, and signal for any other id", () => {
    assert.strictEqual(findStepLineKind(plan, "fetch"), "action");
    assert.strictEqual(findStepLineKind(plan, "implement"), "agent");
    assert.strictEqual(findStepLineKind(plan, "pr_merged"), "signal");
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
    assert.strictEqual(describeFailureReason("validation-error"), "validation error");
    assert.strictEqual(describeFailureReason("expression-error"), "expression error");
    assert.strictEqual(describeFailureReason("controller-error"), "controller error");
    assert.strictEqual(describeFailureReason("iteration-limit"), "iteration limit");
    assert.strictEqual(describeFailureReason("workspace-failed"), "workspace failed");
    assert.strictEqual(describeFailureReason("schema-failure"), "schema failure");
    assert.strictEqual(describeFailureReason("session-failed"), "session failed");
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
    subscriptions: [],
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
    subscriptions: [],
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

  it("names the runner under a running agent step of a run whose runner is offline", () => {
    const agentStep: Run = {
      ...PINNED,
      plan: {
        ...PINNED.plan,
        steps: [{ id: "implement", kind: "agent", agent: "ada", prompt: "Fix it" }],
      },
      steps: [{ stepId: "implement", iteration: 1, status: "running", startedAt: START }],
    };
    assert.deepStrictEqual(describeRunnerWait(agentStep, OFFLINE, [], "UTC"), {
      stepIds: new Set(["implement"]),
      text: "Waiting for runner mac-mini to reconnect (offline since 24 Sep 12:02)",
    });
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

describe("listAwaitedSignals", () => {
  /** Returns a signal trigger with `id`, as a plan declares it. */
  const buildSignalTrigger = (id: string) =>
    ({
      id,
      kind: "signal",
      on: { kind: "github.pr.merged", connectionId: "any" },
      correlation: { event: "event.payload.prNumber", run: "steps.open_pr.output.prNumber" },
    }) as const;
  const OPENED: StepRecord = {
    stepId: "open_pr",
    iteration: 1,
    status: "completed",
    startedAt: START,
    finishedAt: at(1_000),
    output: { prNumber: 42 },
  };
  /** A running run whose pull request is open, with nothing left to run. */
  const WAITING: Run = {
    id: PARENT,
    workflowId: null,
    plan: {
      name: "Open a pull request",
      triggers: [
        { id: "weekdays", kind: "start", on: { schedule: "0 9 * * 1-5" } },
        buildSignalTrigger("pr_merged"),
        buildSignalTrigger("checks_failed"),
      ],
      steps: [{ id: "open_pr", kind: "action", action: "github.pr.open" }],
    },
    inputs: {},
    origin: { kind: "manual", actor: "user" },
    subscriptions: [],
    steps: [OPENED],
    edgeTraversals: [],
    status: "running",
    createdAt: START,
    startedAt: START,
  };

  it("lists the plan's signal triggers, and no start trigger, while nothing runs", () => {
    assert.deepStrictEqual(listAwaitedSignals(WAITING), ["pr_merged", "checks_failed"]);
  });

  it("lists none while a record runs or is pending, as a signal that just fired is", () => {
    for (const record of [
      { stepId: "open_pr", iteration: 2, status: "running", startedAt: at(2_000) },
      { stepId: "pr_merged", iteration: 1, status: "pending" },
    ] as const) {
      assert.deepStrictEqual(listAwaitedSignals({ ...WAITING, steps: [OPENED, record] }), []);
    }
  });

  it("lists none for a run that is not running, or whose plan has no signal trigger", () => {
    assert.deepStrictEqual(listAwaitedSignals({ ...WAITING, status: "pending", steps: [] }), []);
    assert.deepStrictEqual(listAwaitedSignals({ ...WAITING, status: "cancelled" }), []);
    assert.deepStrictEqual(
      listAwaitedSignals({ ...WAITING, plan: { ...WAITING.plan, triggers: [] } }),
      [],
    );
  });
});

describe("describeStepSession", () => {
  const SESSION_ID = "01a06d02-c111-7a0e-8b3d-9c1f00005e55";
  const ATLAS = buildRunner("runner-atlas", "atlas");

  it("shows the session's title and status", () => {
    const session = buildSession({ id: SESSION_ID, title: "Implement the fix", status: "busy" });
    assert.deepStrictEqual(describeStepSession(SESSION_ID, [session], undefined), {
      sessionId: SESSION_ID,
      title: "Implement the fix",
      status: "busy",
      wait: undefined,
    });
  });

  it("shows the id's tail for a session not read yet, or one with no title", () => {
    assert.deepStrictEqual(describeStepSession(SESSION_ID, [], undefined), {
      sessionId: SESSION_ID,
      title: "session 00005e55",
      status: undefined,
      wait: undefined,
    });
    const untitled = buildSession({ id: SESSION_ID, title: "", status: "exited" });
    assert.strictEqual(
      describeStepSession(SESSION_ID, [untitled], undefined).title,
      "session 00005e55",
    );
  });

  it("says a queued session waits for a free session slot on its online runner", () => {
    const queued = buildSession({ id: SESSION_ID, status: "queued", runnerId: ATLAS.id });
    assert.strictEqual(
      describeStepSession(SESSION_ID, [queued], ATLAS).wait,
      "Waiting for runner atlas to free a session slot",
    );
  });

  it("gives no wait when the runner is offline or unknown, or the session is not queued", () => {
    const queued = buildSession({ id: SESSION_ID, status: "queued", runnerId: ATLAS.id });
    const offline: Runner = { ...ATLAS, connectivity: "offline" };
    // The runner-wait line already says that the step waits for the runner to reconnect.
    assert.strictEqual(describeStepSession(SESSION_ID, [queued], offline).wait, undefined);
    assert.strictEqual(describeStepSession(SESSION_ID, [queued], undefined).wait, undefined);
    const busy = { ...queued, status: "busy" } as const;
    assert.strictEqual(describeStepSession(SESSION_ID, [busy], ATLAS).wait, undefined);
  });
});
