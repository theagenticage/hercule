import { assert, describe, it } from "vitest";
import type { Trigger } from "@hercule/contract";
import {
  buildDiscardHeldQuestion,
  buildSpawnBoundRows,
  describeBoundUse,
  describeBreakerPauses,
  describeStartTriggerStatus,
  parseSpawnBoundDraft,
} from "./spawn-bounds";

/** An active start trigger under the default bound, with room left in its window. */
const NEW_ISSUE: Trigger = {
  workflowId: "01a06d02-beff-7037-9f5b-0428220159aa",
  workflowName: "GitHub work",
  triggerId: "new_issue",
  kind: "start",
  on: { kind: "github.issue.opened", connectionId: "any" },
  status: "active",
  spawnBound: { maxRuns: 30, windowSeconds: 3600, isDefault: true },
  runsInWindow: 12,
  heldCount: 0,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};

/** A signal trigger: it starts no runs, so it carries no bound. */
const ON_REVIEW: Trigger = {
  workflowId: NEW_ISSUE.workflowId,
  workflowName: NEW_ISSUE.workflowName,
  triggerId: "on_review",
  kind: "signal",
  on: { kind: "github.pull_request.reviewed", connectionId: "any" },
  createdAt: NEW_ISSUE.createdAt,
  updatedAt: NEW_ISSUE.updatedAt,
};

describe("describeStartTriggerStatus", () => {
  it("says who paused a paused trigger", () => {
    assert.strictEqual(describeStartTriggerStatus({ status: "active" }), "active");
    assert.strictEqual(
      describeStartTriggerStatus({ status: "paused", pausedBy: "breaker" }),
      "paused by the breaker",
    );
    assert.strictEqual(
      describeStartTriggerStatus({ status: "paused", pausedBy: "manual" }),
      "paused manually",
    );
    // Paused before the breaker existed, so nothing says who paused it.
    assert.strictEqual(describeStartTriggerStatus({ status: "paused" }), "paused manually");
  });
});

describe("describeBoundUse", () => {
  it("reads the use against the bound, and where the bound comes from", () => {
    assert.deepStrictEqual(
      describeBoundUse({ maxRuns: 30, windowSeconds: 3600, isDefault: true }, 12),
      {
        text: "12 of 30 per hour",
        title:
          "12 runs started in the last hour, or about to start. The bound is the default from Settings > Bounds.",
      },
    );
    assert.deepStrictEqual(
      describeBoundUse({ maxRuns: 5, windowSeconds: 600, isDefault: false }, 1),
      {
        text: "1 of 5 per 10 minutes",
        title:
          "1 run started in the last 10 minutes, or about to start. The bound is set in the workflow's source.",
      },
    );
  });
});

describe("describeBreakerPauses", () => {
  const OTHER_WORKFLOW = "01a06d02-beff-7037-9f5b-0428220159bb";

  it("names the triggers of one workflow the breaker paused", () => {
    const triggers: Trigger[] = [
      { ...NEW_ISSUE, triggerId: "a", status: "paused", pausedBy: "breaker" },
      { ...NEW_ISSUE, triggerId: "b", status: "paused", pausedBy: "manual" },
      {
        ...NEW_ISSUE,
        triggerId: "c",
        workflowId: OTHER_WORKFLOW,
        status: "paused",
        pausedBy: "breaker",
      },
    ];
    assert.deepStrictEqual(describeBreakerPauses(triggers, NEW_ISSUE.workflowId), {
      text: "paused by the breaker",
      title:
        "The breaker paused its trigger a, which matched more events than its spawn bound allows. Open the workflow to resume it.",
    });
    assert.strictEqual(
      describeBreakerPauses(
        [...triggers, { ...NEW_ISSUE, triggerId: "d", status: "paused", pausedBy: "breaker" }],
        NEW_ISSUE.workflowId,
      )?.title,
      "The breaker paused its triggers a, d, which matched more events than their spawn bounds allow. Open the workflow to resume them.",
    );
  });

  it("returns nothing for a workflow whose triggers the breaker did not pause", () => {
    // A trigger keeps `pausedBy` after a resume, so only a paused one counts.
    const resumed: Trigger = { ...NEW_ISSUE, status: "active", pausedBy: "breaker" };
    assert.isUndefined(describeBreakerPauses([resumed], NEW_ISSUE.workflowId));
    assert.isUndefined(describeBreakerPauses([], NEW_ISSUE.workflowId));
  });
});

describe("buildDiscardHeldQuestion", () => {
  it("counts the held events, one or many", () => {
    assert.strictEqual(
      buildDiscardHeldQuestion(1),
      "Discard the 1 held event and resume? They stay in the event log, but start no runs.",
    );
    assert.strictEqual(
      buildDiscardHeldQuestion(45),
      "Discard the 45 held events and resume? They stay in the event log, but start no runs.",
    );
  });
});

describe("buildSpawnBoundRows", () => {
  /** The workflow of `NEW_ISSUE`, enabled and valid. */
  const GITHUB_WORK = { id: NEW_ISSUE.workflowId, enabled: true };

  it("reads an active trigger's bound use and status", () => {
    const [row] = buildSpawnBoundRows([NEW_ISSUE], [GITHUB_WORK]);
    assert.deepStrictEqual(row, {
      key: `${NEW_ISSUE.workflowId}/new_issue`,
      workflowId: NEW_ISSUE.workflowId,
      workflowName: "GitHub work",
      triggerId: "new_issue",
      boundUse: {
        text: "12 of 30 per hour",
        title:
          "12 runs started in the last hour, or about to start. The bound is the default from Settings > Bounds.",
      },
      isDefault: true,
      isNearLimit: false,
      status: { text: "active", tone: "muted" },
      isPaused: false,
      heldCount: 0,
      canDiscardHeldEvents: false,
    });
  });

  it("leaves out a trigger with no bound", () => {
    assert.deepStrictEqual(buildSpawnBoundRows([ON_REVIEW], [GITHUB_WORK]), []);
  });

  it("reads a trigger near its limit from four fifths of its bound", () => {
    const near = (runsInWindow: number) =>
      buildSpawnBoundRows([{ ...NEW_ISSUE, runsInWindow }], [GITHUB_WORK])[0]?.isNearLimit;
    assert.isFalse(near(23));
    assert.isTrue(near(24));
    assert.isTrue(near(30));
  });

  it("says who paused a trigger, and offers to discard only what a paused trigger holds", () => {
    const [breaker, manual, legacy, single] = buildSpawnBoundRows(
      [
        { ...NEW_ISSUE, triggerId: "a", status: "paused", pausedBy: "breaker", heldCount: 45 },
        { ...NEW_ISSUE, triggerId: "b", status: "paused", pausedBy: "manual", heldCount: 0 },
        // Paused before the breaker existed, so nothing says who paused it.
        { ...NEW_ISSUE, triggerId: "c", status: "paused" },
        // Paused manually after the breaker paused it, so it keeps what it held.
        { ...NEW_ISSUE, triggerId: "d", status: "paused", pausedBy: "manual", heldCount: 1 },
      ],
      [GITHUB_WORK],
    );
    assert.deepStrictEqual(breaker?.status, { text: "paused by the breaker", tone: "attn" });
    assert.isTrue(breaker?.canDiscardHeldEvents);
    assert.deepStrictEqual(manual?.status, { text: "paused manually", tone: "attn" });
    assert.isFalse(manual?.canDiscardHeldEvents);
    assert.strictEqual(legacy?.status.text, "paused manually");
    assert.isTrue(single?.canDiscardHeldEvents);
  });

  it("offers no discard on an active trigger that still starts what it held", () => {
    const [row] = buildSpawnBoundRows([{ ...NEW_ISSUE, heldCount: 4 }], [GITHUB_WORK]);
    assert.strictEqual(row?.heldCount, 4);
    assert.isFalse(row?.canDiscardHeldEvents);
  });

  it("says when an invalid or disabled workflow is what stops an active trigger", () => {
    const status = (workflow: { id: string; enabled: boolean; invalidSince?: string }) =>
      buildSpawnBoundRows([NEW_ISSUE], [workflow])[0]?.status;
    const invalidSince = "2026-10-01T08:00:00.000Z";
    assert.deepStrictEqual(status({ ...GITHUB_WORK, invalidSince }), {
      text: "workflow invalid",
      tone: "fail",
    });
    assert.deepStrictEqual(status({ ...GITHUB_WORK, enabled: false }), {
      text: "workflow disabled",
      tone: "muted",
    });
    // An invalid workflow says so first: turning it on would not start the trigger.
    assert.strictEqual(
      status({ ...GITHUB_WORK, enabled: false, invalidSince })?.text,
      "workflow invalid",
    );
    // A paused trigger says it is paused, because only a resume starts it again.
    assert.strictEqual(
      buildSpawnBoundRows(
        [{ ...NEW_ISSUE, status: "paused", pausedBy: "breaker" }],
        [{ ...GITHUB_WORK, enabled: false, invalidSince }],
      )[0]?.status.text,
      "paused by the breaker",
    );
    // A workflow missing from the list reads as enabled and valid.
    assert.strictEqual(buildSpawnBoundRows([NEW_ISSUE], [])[0]?.status.text, "active");
  });

  it("orders rows by workflow name, then trigger id", () => {
    const rows = buildSpawnBoundRows(
      [
        { ...NEW_ISSUE, workflowName: "Screener", triggerId: "b" },
        { ...NEW_ISSUE, workflowName: "GitHub work", triggerId: "z" },
        { ...NEW_ISSUE, workflowName: "Screener", triggerId: "a" },
      ],
      [GITHUB_WORK],
    );
    assert.deepStrictEqual(
      rows.map((row) => `${row.workflowName}/${row.triggerId}`),
      ["GitHub work/z", "Screener/a", "Screener/b"],
    );
  });
});

describe("parseSpawnBoundDraft", () => {
  const RUNS_ERROR = "Enter a whole number of runs from 1 to 10,000.";
  const SECONDS_ERROR = "Enter a whole number of seconds from 1 to 2,592,000, which is 30 days.";

  it("returns the bound when both fields hold a whole number in range", () => {
    assert.deepStrictEqual(parseSpawnBoundDraft({ maxRuns: " 30 ", windowSeconds: "3600" }), {
      ok: true,
      bound: { maxRuns: 30, windowSeconds: 3600 },
    });
    assert.deepStrictEqual(parseSpawnBoundDraft({ maxRuns: "10000", windowSeconds: "2592000" }), {
      ok: true,
      bound: { maxRuns: 10_000, windowSeconds: 2_592_000 },
    });
  });

  it("returns an error under each field that holds none", () => {
    assert.deepStrictEqual(parseSpawnBoundDraft({ maxRuns: "0", windowSeconds: "1.5" }), {
      ok: false,
      errors: { maxRuns: RUNS_ERROR, windowSeconds: SECONDS_ERROR },
    });
    assert.deepStrictEqual(parseSpawnBoundDraft({ maxRuns: "30", windowSeconds: "" }), {
      ok: false,
      errors: { windowSeconds: SECONDS_ERROR },
    });
  });

  it("refuses a bound above the largest the controller accepts", () => {
    assert.deepStrictEqual(parseSpawnBoundDraft({ maxRuns: "10001", windowSeconds: "2592001" }), {
      ok: false,
      errors: { maxRuns: RUNS_ERROR, windowSeconds: SECONDS_ERROR },
    });
  });
});
