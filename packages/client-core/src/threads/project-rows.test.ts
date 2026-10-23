/**
 * Tests the helpers of the desktop sidebar's rows. The tests check that:
 *
 * - a row's second line names a branch a person chose, else the main
 *   workspace, else the machine, and never a generated branch;
 * - a thread last started when it was created, or reopened after that.
 */
import { describe, expect, it } from "vitest";
import { buildThreadPlaceLabel, pickLastStartedAt } from "./project-rows";
import {
  MOSS,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildSession,
} from "./workspaces.testing";

const buildTimestamp = (minute: number): string => `2026-09-10T09:0${String(minute)}:00.000Z`;

const FLAKY = buildSession({
  id: "s-flaky",
  projectId: WEBSHOP_PROJECT.id,
  createdAt: buildTimestamp(1),
});

describe("buildThreadPlaceLabel", () => {
  const label = (over: Partial<Parameters<typeof buildThreadPlaceLabel>[0]>) =>
    buildThreadPlaceLabel({
      workspace: PRIMARY,
      branch: null,
      machine: "moss",
      resources: [WEBSHOP],
      runners: [MOSS],
      ...over,
    });

  it("cuts a long branch name a person chose in the middle and keeps its end", () => {
    expect(label({ branch: "rogier/fix-the-sidebar-rows" })).toEqual({
      clip: "rogier/fix-the-",
      keep: "sidebar-rows",
    });
    expect(label({ branch: "main" })).toEqual({ clip: "", keep: "main" });
  });

  it("names a main workspace with no known branch by its repo and machine", () => {
    expect(label({})).toEqual({ clip: "webshop", keep: " · moss" });
  });

  it("names the machine when the branch is one the controller generated", () => {
    expect(label({ workspace: THREAD_3F1, branch: "hercule/thread-3f1" })).toEqual({
      clip: "moss",
      keep: "",
    });
  });

  it("names the machine for a thread with no workspace, and says so when it has neither", () => {
    expect(label({ workspace: undefined })).toEqual({ clip: "moss", keep: "" });
    expect(label({ workspace: undefined, machine: null })).toEqual({
      clip: "No workspace",
      keep: "",
    });
  });
});

describe("pickLastStartedAt", () => {
  it("returns the creation time, or a later reopening, and ignores a reopening older than the thread", () => {
    expect(pickLastStartedAt(FLAKY)).toBe(buildTimestamp(1));
    expect(pickLastStartedAt({ ...FLAKY, reopenedAt: buildTimestamp(7) })).toBe(buildTimestamp(7));
    expect(pickLastStartedAt({ ...FLAKY, reopenedAt: buildTimestamp(0) })).toBe(buildTimestamp(1));
  });
});
