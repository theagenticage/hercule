import { describe, expect, it } from "vitest";
import { decideScreenFace } from "./sidebar-face";

describe("decideScreenFace", () => {
  it.each([
    ["the new-thread screen", "/"],
    ["a thread", "/threads/ses_1"],
    ["a subagent of a thread", "/threads/ses_1/subagents/sub_1"],
    ["an assistant's Conversation", "/assistants/asst_1"],
  ])("shows the threads face on %s", (_, pathname) => {
    expect(decideScreenFace(pathname)).toBe("threads");
  });

  it("shows the orchestration face on Intake, Workflows and a run's page", () => {
    expect(decideScreenFace("/intake")).toBe("orchestration");
    expect(decideScreenFace("/workflows")).toBe("orchestration");
    expect(decideScreenFace("/workflows/wf_1")).toBe("orchestration");
    expect(decideScreenFace("/runs/run_1")).toBe("orchestration");
  });

  it.each([
    ["the Office", "/office"],
    ["Settings", "/settings"],
    ["a section of Settings", "/settings/appearance"],
  ])("keeps the face that was showing on %s", (_, pathname) => {
    expect(decideScreenFace(pathname)).toBeNull();
  });
});
