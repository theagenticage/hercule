/**
 * Tests `describeThreadPlace`. The tests check that the sentence names the
 * project, the workspace, the machine and the branch, each once, and says what
 * is missing when the thread has no project or no workspace.
 */
import { describe, expect, it } from "vitest";
import { describeThreadPlace } from "./thread-place";

describe("describeThreadPlace", () => {
  it("names the project, the main workspace by its repo, the machine and the branch", () => {
    expect(
      describeThreadPlace({
        projectName: "webshop",
        workspace: { kind: "primary", name: "webshop" },
        machine: "moss",
        branch: "main",
      }),
    ).toBe("in webshop, webshop main workspace, on moss, branch main");
  });

  it("does not name the branch again when the workspace is named after it", () => {
    expect(
      describeThreadPlace({
        projectName: "webshop",
        workspace: { kind: "ephemeral", name: "hercule/thread-3f1" },
        machine: "moss",
        branch: "hercule/thread-3f1",
      }),
    ).toBe("in webshop, workspace hercule/thread-3f1, on moss");
  });

  it("says when the thread has no project and no workspace", () => {
    expect(
      describeThreadPlace({ projectName: null, workspace: null, machine: "moss", branch: null }),
    ).toBe("in no project, no workspace, on moss");
  });
});
