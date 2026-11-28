/**
 * Tests the request that starts a Thread on a Task and the words around
 * starting one and moving one: which workspace the new Thread gets, and what
 * the user is told when it gets none.
 */
import { describe, expect, it } from "vitest";
import {
  buildTaskThreadStart,
  describeNextThreadJoin,
  describeThreadRefused,
  describeThreadStarted,
  type NewestSessionPlace,
} from "./thread-changes";

const TARGET = { id: "task-1", title: "Refund emails show the wrong currency" };
const IN_PROJECT = { ...TARGET, projectId: "storefront" };
const READY = { id: "ws-1", runnerId: "runner-1", status: "ready" } as const;

describe("buildTaskThreadStart", () => {
  it.each<[string, typeof TARGET, NewestSessionPlace, object, string | undefined]>([
    [
      "joins the Task and reuses the newest Thread's ready workspace on its runner",
      IN_PROJECT,
      { workspaceId: "ws-1", workspace: READY },
      {
        prompt: "Check the mails",
        taskId: "task-1",
        projectId: "storefront",
        runnerId: "runner-1",
        workspace: { kind: "existing", workspaceId: "ws-1" },
      },
      undefined,
    ],
    [
      "names no Project for a Task with none",
      TARGET,
      { workspaceId: "ws-1", workspace: READY },
      {
        prompt: "Check the mails",
        taskId: "task-1",
        runnerId: "runner-1",
        workspace: { kind: "existing", workspaceId: "ws-1" },
      },
      undefined,
    ],
    [
      "has no workspace to reuse when the Task has no Thread yet, and says nothing",
      IN_PROJECT,
      { workspaceId: null, workspace: null },
      { prompt: "Check the mails", taskId: "task-1", projectId: "storefront" },
      undefined,
    ],
  ])("%s", (_, target, newest, input, note) => {
    expect(buildTaskThreadStart("Check the mails", target, newest)).toEqual({ input, note });
  });

  it.each([
    ["is not ready", { ...READY, status: "lost" as const }],
    ["cannot be found", null],
  ])(
    "leaves the workspace out and says so when the newest Thread's workspace %s",
    (_, workspace) => {
      const start = buildTaskThreadStart("Check the mails", IN_PROJECT, {
        workspaceId: "ws-1",
        workspace,
      });
      expect(start.input).toEqual({
        prompt: "Check the mails",
        taskId: "task-1",
        projectId: "storefront",
      });
      expect(start.note).toBe(
        "The workspace of its last thread is no longer available, so the new thread started without one.",
      );
    },
  );
});

describe("the words", () => {
  it("names the Task a thread started on, cutting a long title", () => {
    expect(describeThreadStarted({ title: "Review PR" })).toBe('A thread started on "Review PR".');
    expect(describeThreadStarted(TARGET)).toBe(
      'A thread started on "Refund emails show the wrong cu…".',
    );
  });

  it.each([
    ["a reason with no full stop", "The Task is finished"],
    ["a reason that ends in a full stop", "The Task is finished."],
  ])("says why a start was refused and that the words are kept, for %s", (_name, reason) => {
    expect(describeThreadRefused({ title: "Review PR" }, reason)).toBe(
      'Could not start a thread on "Review PR": The Task is finished. Your words are back in the pane.',
    );
  });

  it("says the next thread in the workspace still joins the old Task", () => {
    expect(describeNextThreadJoin({ title: "Review PR" })).toBe(
      'The next thread here still joins "Review PR".',
    );
  });
});
