/**
 * Tests `applyCleanupChange` and `describeCleanupOutcome`: how a cleanup's
 * progress moves from the first answer to its end, and the words of its
 * result.
 */
import { USED_SINCE_LOOKED_REFUSAL, type Workspace } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildWorkspace } from "../threads/workspaces.testing";
import type { CleanupRow, CleanupStart } from "./cleanup";
import {
  applyCleanupChange,
  describeCleanupOutcome,
  type CleanupProgress,
  type RemovalOutcome,
} from "./cleanup-progress";

const GB = 1e9;

/** Returns the canonical id the client accepts for the thing numbered `number`. */
const uuid = (number: number): string =>
  `01a06d02-7400-7000-8000-${String(number).padStart(12, "0")}`;

/** Returns the row of workspace number `number` that frees `freesGb` GB, or is unmeasured when it is `null`. */
const buildRow = (number: number, freesGb: number | null): CleanupRow => ({
  workspaceId: uuid(number),
  name: `Thread ${String(number)}`,
  sizeBytes: freesGb === null ? null : freesGb * 2 * GB,
  freesBytes: freesGb === null ? null : freesGb * GB,
  sizeText: null,
  freesText: null,
  lastUsedText: "2 weeks ago",
  measuringNote: null,
  group: "done",
  expectedLastUsedAt: null,
  unarchivedThreadIds: [],
});

/** Returns the workspace number `number` in the state `status`, with the reason `message` when it stayed. */
const buildStored = (
  number: number,
  status: Workspace["status"],
  message: string | null = null,
): Workspace => buildWorkspace({ id: uuid(number), kind: "ephemeral", status, message });

const removed: RemovalOutcome = { kind: "removed" };
const removing: RemovalOutcome = { kind: "removing" };
const refused: RemovalOutcome = { kind: "refused", message: "No.", retry: true };

const ROWS = [buildRow(1, 30), buildRow(2, 11)];
const STARTING: CleanupProgress = { kind: "starting", rows: ROWS };

/** Returns what `archiveAndRemoveWorkspaces` returns when both removals were requested. */
const requestedBoth = (archivedCount: number): CleanupStart => ({
  status: "archived",
  archivedCount,
  removal: {
    status: "started",
    results: [
      { workspaceId: uuid(1), outcome: "requested" },
      { workspaceId: uuid(2), outcome: "requested" },
    ],
  },
});

/** Returns the progress once the first answer is `start`, and fails when the cleanup is not removing. */
const answerStart = (start: CleanupStart): Extract<CleanupProgress, { kind: "removing" }> => {
  const progress = applyCleanupChange(STARTING, { kind: "startAnswered", start });
  if (progress.kind !== "removing") throw new Error(`Unexpected kind ${progress.kind}`);
  return progress;
};

describe("applyCleanupChange: the first answer", () => {
  it("stops the cleanup with the message when the archive failed", () => {
    expect(
      applyCleanupChange(STARTING, {
        kind: "startAnswered",
        start: { status: "archiveFailed", message: "Thread 103 is working. Stop it first." },
      }),
    ).toEqual({ kind: "stopped", rows: ROWS, message: "Thread 103 is working. Stop it first." });
  });

  it("marks each requested removal as removing, with no result yet", () => {
    expect(answerStart(requestedBoth(9))).toEqual({
      kind: "removing",
      rows: ROWS,
      archivedCount: 9,
      outcomes: new Map<string, RemovalOutcome>([
        [uuid(1), removing],
        [uuid(2), removing],
      ]),
      result: null,
      failureMessages: new Map(),
    });
  });

  it("refuses a row the controller refused, and words one used since the dialog showed it", () => {
    const progress = answerStart({
      status: "archived",
      archivedCount: 0,
      removal: {
        status: "started",
        results: [
          { workspaceId: uuid(1), outcome: "refused", message: USED_SINCE_LOOKED_REFUSAL },
          { workspaceId: uuid(2), outcome: "refused", message: "Stop sessions 01a0 first." },
        ],
      },
    });

    expect(progress.outcomes).toEqual(
      new Map<string, RemovalOutcome>([
        [uuid(1), { kind: "refused", message: "Used since you looked.", retry: false }],
        [uuid(2), { kind: "refused", message: "Stop sessions 01a0 first.", retry: true }],
      ]),
    );
  });

  it("says the machine did not say why for a refusal with no message", () => {
    const progress = answerStart({
      status: "archived",
      archivedCount: 0,
      removal: {
        status: "started",
        results: [{ workspaceId: uuid(1), outcome: "refused" }],
      },
    });

    expect(progress.outcomes.get(uuid(1))).toEqual({
      kind: "refused",
      message: "The machine did not say why. Try again.",
      retry: true,
    });
  });

  it("keeps every row removing when the call failed, and keeps the archive count", () => {
    const progress = answerStart({
      status: "archived",
      archivedCount: 2,
      removal: { status: "removalUnknown", message: "The controller is restarting." },
    });

    expect(progress.archivedCount).toBe(2);
    expect(progress.outcomes).toEqual(
      new Map<string, RemovalOutcome>([
        [uuid(1), removing],
        [uuid(2), removing],
      ]),
    );
  });

  it("does nothing to a cleanup that is not starting", () => {
    const progress = answerStart(requestedBoth(0));

    expect(applyCleanupChange(progress, { kind: "startAnswered", start: requestedBoth(5) })).toBe(
      progress,
    );
  });
});

describe("applyCleanupChange: a read of the workspaces", () => {
  it("reads a deleted workspace as removed and a disposing one as still being removed", () => {
    const progress = applyCleanupChange(answerStart(requestedBoth(0)), {
      kind: "workspacesRead",
      workspaces: [buildStored(1, "deleted"), buildStored(2, "disposing")],
    });

    expect(progress.kind === "removing" && progress.outcomes).toEqual(
      new Map<string, RemovalOutcome>([
        [uuid(1), removed],
        [uuid(2), removing],
      ]),
    );
    expect(progress.kind === "removing" && progress.result).toBeNull();
  });

  it("refuses a workspace that is back with its own reason, or says so when it has none", () => {
    const progress = applyCleanupChange(answerStart(requestedBoth(0)), {
      kind: "workspacesRead",
      workspaces: [
        buildStored(1, "ready", "The runner refused safe removal."),
        buildStored(2, "ready"),
      ],
    });

    expect(progress.kind === "removing" && progress.outcomes).toEqual(
      new Map<string, RemovalOutcome>([
        [uuid(1), { kind: "refused", message: "The runner refused safe removal.", retry: true }],
        [
          uuid(2),
          { kind: "refused", message: "The machine did not say why. Try again.", retry: true },
        ],
      ]),
    );
  });

  it("words the result once every row has settled", () => {
    const progress = applyCleanupChange(answerStart(requestedBoth(9)), {
      kind: "workspacesRead",
      workspaces: [buildStored(1, "deleted"), buildStored(2, "deleted")],
    });

    expect(progress.kind === "removing" && progress.result).toEqual({
      allRemoved: true,
      text: "Archived 9 threads and removed 2 workspaces. 41 GB freed.",
    });
  });

  it("shows the failure of the removal call, not a reason left from an earlier attempt", () => {
    const failed = answerStart({
      status: "archived",
      archivedCount: 0,
      removal: { status: "removalUnknown", message: "The controller is restarting." },
    });

    const progress = applyCleanupChange(failed, {
      kind: "workspacesRead",
      workspaces: [buildStored(1, "ready", "Refused last week."), buildStored(2, "deleted")],
    });

    expect(progress.kind === "removing" && progress.outcomes.get(uuid(1))).toEqual({
      kind: "refused",
      message: "The controller is restarting.",
      retry: true,
    });
    expect(progress.kind === "removing" && progress.outcomes.get(uuid(2))).toEqual(removed);
  });

  it("returns the same progress when the read changes no row", () => {
    const progress = answerStart(requestedBoth(0));

    expect(
      applyCleanupChange(progress, {
        kind: "workspacesRead",
        workspaces: [buildStored(1, "disposing"), buildStored(2, "disposing")],
      }),
    ).toBe(progress);
  });

  it("returns the same progress when a workspace is missing from the read", () => {
    const progress = answerStart(requestedBoth(0));

    expect(applyCleanupChange(progress, { kind: "workspacesRead", workspaces: [] })).toBe(progress);
  });

  it("returns the same progress once the cleanup has its result, or before it is removing", () => {
    const settled = applyCleanupChange(answerStart(requestedBoth(0)), {
      kind: "workspacesRead",
      workspaces: [buildStored(1, "deleted"), buildStored(2, "deleted")],
    });
    const change = {
      kind: "workspacesRead",
      workspaces: [buildStored(1, "ready")],
    } as const;

    expect(applyCleanupChange(settled, change)).toBe(settled);
    expect(applyCleanupChange(STARTING, change)).toBe(STARTING);
  });
});

describe("applyCleanupChange: Try again", () => {
  /** Returns a cleanup that archived 9 Threads and has the row 1 refused and the row 2 removed. */
  const buildPartlyRefused = (): Extract<CleanupProgress, { kind: "removing" }> => {
    const progress = applyCleanupChange(answerStart(requestedBoth(9)), {
      kind: "workspacesRead",
      workspaces: [
        buildStored(1, "ready", "A process had a file open."),
        buildStored(2, "deleted"),
      ],
    });
    if (progress.kind !== "removing") throw new Error("Unexpected kind");
    return progress;
  };

  it("puts the refused row back to removing and clears the result", () => {
    const partlyRefused = buildPartlyRefused();
    expect(partlyRefused.result?.allRemoved).toBe(false);

    const progress = applyCleanupChange(partlyRefused, {
      kind: "retryAsked",
      workspaceId: uuid(1),
    });

    expect(progress.kind === "removing" && progress.outcomes.get(uuid(1))).toEqual(removing);
    expect(progress.kind === "removing" && progress.outcomes.get(uuid(2))).toEqual(removed);
    expect(progress.kind === "removing" && progress.result).toBeNull();
  });

  it("does nothing for a row that is not refused", () => {
    const partlyRefused = buildPartlyRefused();

    expect(applyCleanupChange(partlyRefused, { kind: "retryAsked", workspaceId: uuid(2) })).toBe(
      partlyRefused,
    );
    expect(applyCleanupChange(STARTING, { kind: "retryAsked", workspaceId: uuid(1) })).toBe(
      STARTING,
    );
  });

  it("keeps the archive count when the answer arrives, and settles from the next read", () => {
    const asked = applyCleanupChange(buildPartlyRefused(), {
      kind: "retryAsked",
      workspaceId: uuid(1),
    });

    const answered = applyCleanupChange(asked, {
      kind: "retryAnswered",
      workspaceId: uuid(1),
      removal: {
        status: "started",
        results: [{ workspaceId: uuid(1), outcome: "requested" }],
      },
    });
    const settled = applyCleanupChange(answered, {
      kind: "workspacesRead",
      workspaces: [buildStored(1, "deleted"), buildStored(2, "deleted")],
    });

    expect(answered.kind === "removing" && answered.archivedCount).toBe(9);
    expect(settled.kind === "removing" && settled.result?.text).toBe(
      "Archived 9 threads and removed 2 workspaces. 41 GB freed.",
    );
  });

  it("refuses the row again, with the call's own error, when the call failed", () => {
    const asked = applyCleanupChange(buildPartlyRefused(), {
      kind: "retryAsked",
      workspaceId: uuid(1),
    });
    const answered = applyCleanupChange(asked, {
      kind: "retryAnswered",
      workspaceId: uuid(1),
      removal: { status: "removalUnknown", message: "The controller is restarting." },
    });

    const settled = applyCleanupChange(answered, {
      kind: "workspacesRead",
      workspaces: [
        buildStored(1, "ready", "A process had a file open."),
        buildStored(2, "deleted"),
      ],
    });

    expect(settled.kind === "removing" && settled.outcomes.get(uuid(1))).toEqual({
      kind: "refused",
      message: "The controller is restarting.",
      retry: true,
    });
  });
});

describe("describeCleanupOutcome", () => {
  const items = [buildRow(1, 30), buildRow(2, 11), buildRow(3, 5)];

  it("words the toast when every workspace was removed", () => {
    const outcomes = new Map<string, RemovalOutcome>([
      [uuid(1), removed],
      [uuid(2), removed],
    ]);

    expect(describeCleanupOutcome(9, items.slice(0, 2), outcomes)).toEqual({
      allRemoved: true,
      text: "Archived 9 threads and removed 2 workspaces. 41 GB freed.",
    });
  });

  it("uses singular words", () => {
    expect(
      describeCleanupOutcome(
        1,
        [buildRow(1, 2)],
        new Map<string, RemovalOutcome>([[uuid(1), removed]]),
      ),
    ).toEqual({
      allRemoved: true,
      text: "Archived 1 thread and removed 1 workspace. 2 GB freed.",
    });
  });

  it("words the dialog's head when some removals were refused, always saying what was archived", () => {
    const outcomes = new Map<string, RemovalOutcome>([
      [uuid(1), removed],
      [uuid(2), refused],
      [uuid(3), refused],
    ]);

    expect(describeCleanupOutcome(9, items, outcomes)).toEqual({
      allRemoved: false,
      text: "Archived 9 threads. Removed 1 of 3 workspaces.",
    });
    expect(
      describeCleanupOutcome(
        1,
        [buildRow(1, 1)],
        new Map<string, RemovalOutcome>([[uuid(1), refused]]),
      ),
    ).toEqual({
      allRemoved: false,
      text: "Archived 1 thread. Removed 0 of 1 workspace.",
    });
  });

  it("leaves out the archive and the size when there is none", () => {
    expect(
      describeCleanupOutcome(
        0,
        [buildRow(1, null)],
        new Map<string, RemovalOutcome>([[uuid(1), removed]]),
      )?.text,
    ).toBe("Removed 1 workspace.");
    expect(
      describeCleanupOutcome(
        0,
        [buildRow(1, 3)],
        new Map<string, RemovalOutcome>([[uuid(1), refused]]),
      )?.text,
    ).toBe("Removed 0 of 1 workspace.");
  });

  it("gives no words while a removal is still going or has no outcome", () => {
    const rows = items.slice(0, 2);

    expect(
      describeCleanupOutcome(
        2,
        rows,
        new Map<string, RemovalOutcome>([
          [uuid(1), removed],
          [uuid(2), removing],
        ]),
      ),
    ).toBeNull();
    expect(
      describeCleanupOutcome(2, rows, new Map<string, RemovalOutcome>([[uuid(1), removed]])),
    ).toBeNull();
  });
});
