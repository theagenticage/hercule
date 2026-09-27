import { assert, describe, it } from "vitest";
import type { Run } from "@hercule/contract";
import { describeRunWorkspace } from "./run-workspace";
import { buildWorkspace } from "./threads/workspaces.testing";

const WORKSPACE_ID = "0199c0ff-4444-7000-8000-000000000001";

const RUNNING: Run = {
  id: "0199c0ff-2222-7000-8000-000000000001",
  workflowId: null,
  plan: { name: "Commit the fix", steps: [{ id: "commit", kind: "action", action: "git.commit" }] },
  inputs: {},
  origin: { kind: "manual", actor: "user" },
  status: "running",
  steps: [{ stepId: "commit", iteration: 1, status: "running", startedAt: "2026-09-25T10:00:00Z" }],
  edgeTraversals: [],
  createdAt: "2026-09-25T10:00:00Z",
  startedAt: "2026-09-25T10:00:00Z",
  workspaceId: WORKSPACE_ID,
};

const FAILED: Run = {
  ...RUNNING,
  status: "failed",
  failureReason: "step-failed",
  failedStepId: "commit",
  finishedAt: "2026-09-24T23:30:00Z",
};

const COMPLETED: Run = { ...RUNNING, status: "completed", finishedAt: "2026-09-25T10:01:00Z" };

const EPHEMERAL = buildWorkspace({ id: WORKSPACE_ID, kind: "ephemeral" });

/** Kept for inspection until 23:30 UTC on 8 Oct: 9 Oct in Amsterdam. */
const KEPT = { ...EPHEMERAL, keptUntil: "2026-10-08T23:30:00Z" };

const DELETED = { ...EPHEMERAL, status: "deleted", disposedAt: "2026-10-03T08:00:00Z" } as const;

const ZONE = "Europe/Amsterdam";

describe("describeRunWorkspace", () => {
  it("asks about the workspace on cancel while the run is live and its ephemeral workspace exists", () => {
    assert.deepStrictEqual(describeRunWorkspace(RUNNING, EPHEMERAL, ZONE), {
      asksOnCancel: true,
      note: undefined,
      offersDelete: false,
    });
    assert.isTrue(
      describeRunWorkspace(RUNNING, { ...EPHEMERAL, status: "provisioning" }, ZONE).asksOnCancel,
    );
  });

  it("does not ask before the workspace has been read, or when it is primary", () => {
    assert.isFalse(describeRunWorkspace(RUNNING, undefined, ZONE).asksOnCancel);
    assert.isFalse(
      describeRunWorkspace(RUNNING, { ...EPHEMERAL, kind: "primary" }, ZONE).asksOnCancel,
    );
  });

  it("says until when a workspace is kept past the run's end, in the user's timezone, and offers to delete it", () => {
    assert.deepStrictEqual(describeRunWorkspace(FAILED, KEPT, ZONE), {
      asksOnCancel: false,
      note: "Workspace kept until 9 Oct",
      offersDelete: true,
    });
    const kept: Run = { ...FAILED, status: "cancelled" };
    assert.strictEqual(describeRunWorkspace(kept, KEPT, ZONE).note, "Workspace kept until 9 Oct");
  });

  it("says a workspace a thread still works in is in use, and does not offer to delete it", () => {
    const joined = { ...EPHEMERAL, sessionIds: ["0199c0ff-3333-7000-8000-000000000001"] };
    for (const run of [FAILED, COMPLETED]) {
      assert.deepStrictEqual(describeRunWorkspace(run, joined, ZONE), {
        asksOnCancel: false,
        note: "Workspace in use by a thread",
        offersDelete: false,
      });
    }
  });

  it("says when the workspace was deleted, from the workspace, whatever the run's status", () => {
    for (const run of [FAILED, COMPLETED]) {
      assert.deepStrictEqual(describeRunWorkspace(run, DELETED, ZONE), {
        asksOnCancel: false,
        note: "Workspace deleted 3 Oct",
        offersDelete: false,
      });
    }
  });

  it("says a workspace kept no later than the run's end, or not yet released, will be deleted shortly", () => {
    const cancelled: Run = { ...COMPLETED, status: "cancelled" };
    const keptToTheEnd = { ...EPHEMERAL, keptUntil: "2026-09-25T10:01:00Z" };
    for (const run of [COMPLETED, cancelled]) {
      for (const workspace of [keptToTheEnd, EPHEMERAL]) {
        assert.deepStrictEqual(describeRunWorkspace(run, workspace, ZONE), {
          asksOnCancel: false,
          note: "Workspace will be deleted shortly",
          offersDelete: false,
        });
      }
    }
  });

  it("says nothing about a lost workspace, or a primary one", () => {
    const nothing = { asksOnCancel: false, note: undefined, offersDelete: false };
    assert.deepStrictEqual(
      describeRunWorkspace(COMPLETED, { ...EPHEMERAL, kind: "primary" }, ZONE),
      nothing,
    );
    assert.deepStrictEqual(
      describeRunWorkspace(FAILED, { ...KEPT, status: "lost" }, ZONE),
      nothing,
    );
    assert.deepStrictEqual(
      describeRunWorkspace(FAILED, { ...DELETED, kind: "primary" }, ZONE),
      nothing,
    );
  });
});
