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

  it.each([
    ["the Office", "/office"],
    ["Settings", "/settings"],
    ["a section of Settings", "/settings/appearance"],
  ])("keeps the face that was showing on %s", (_, pathname) => {
    expect(decideScreenFace(pathname)).toBeNull();
  });
});
