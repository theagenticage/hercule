import { expect, it } from "vitest";
import type { Run } from "@hercule/contract";
import { describeRunWorkspace } from "./run-workspace";
import { buildWorkspace } from "./threads/workspaces.testing";

const workspace = buildWorkspace({
  id: "retained-work",
  kind: "ephemeral",
  sessionIds: [],
  retentionPolicy: "manual",
});
const completed: Run = {
  id: "completed-run",
  workflowId: null,
  plan: { name: "Save work", steps: [{ id: "save", kind: "action", action: "git.commit" }] },
  inputs: {},
  origin: { kind: "manual", actor: "user" },
  subscriptions: [],
  status: "completed",
  steps: [],
  edgeTraversals: [],
  createdAt: "2026-09-25T10:00:00Z",
  startedAt: "2026-09-25T10:00:00Z",
  finishedAt: "2026-09-25T10:01:00Z",
  workspaceId: workspace.id,
};

it("shows manual retained work honestly after its workflow and human Thread ended", () => {
  const reading = describeRunWorkspace(completed, workspace, "Europe/Amsterdam");
  expect(reading.note).toMatch(/manual|retained|kept/i);
  expect(reading.note).not.toMatch(/deleted shortly|until/i);
  expect(reading.offersDelete).toBe(true);
});

it("shows a retained automatic refusal and the next action instead of predicting deletion", () => {
  const message =
    "Ignored files remain. Preserve them or explicitly discard changes. Automatic cleanup will not retry.";
  const reading = describeRunWorkspace(
    completed,
    { ...workspace, retentionPolicy: "automatic", message },
    "Europe/Amsterdam",
  );
  expect(reading.note).toMatch(/ignored|retained|cleanup/i);
  expect(reading.note).not.toMatch(/deleted shortly/i);
  expect(reading.offersDelete).toBe(true);
});

it("shows pending removal as pending and prevents a second disposal request", () => {
  const reading = describeRunWorkspace(
    completed,
    { ...workspace, status: "disposing" },
    "Europe/Amsterdam",
  );
  expect(reading.note).toMatch(/remov|dispos/i);
  expect(reading.note).not.toMatch(/deleted shortly|workspace deleted$/i);
  expect(reading.offersDelete).toBe(false);
});
