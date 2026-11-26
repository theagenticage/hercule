/** Tests the events adapters report themselves about an input: its `user_message` and the skipped-skills warning. */
import { describe, expect, it } from "vitest";
import { buildSkippedSkillsWarning, buildUserMessage } from "./events";

const base = { sessionId: "s-1", turnId: "t-1", text: "hi", steered: false } as const;

/** Returns the `detail` of the completed item. */
const readDetail = (input: Parameters<typeof buildUserMessage>[0]): unknown => {
  const [, completed] = buildUserMessage(input);
  return "detail" in completed ? completed.detail : undefined;
};

describe("buildUserMessage", () => {
  it("lists each translated Skill Reference name once, in order of first appearance", () => {
    const detail = readDetail({
      ...base,
      skillReferences: [
        { referenceName: "review" },
        { referenceName: "webshop:release" },
        { referenceName: "review" },
      ],
    });
    expect(detail).toEqual({ text: "hi", skills: ["review", "webshop:release"] });
  });

  it("omits the skills when none was translated", () => {
    expect(readDetail({ ...base, skillReferences: [] })).toEqual({ text: "hi" });
    expect(readDetail(base)).toEqual({ text: "hi" });
  });
});

describe("buildSkippedSkillsWarning", () => {
  const warn = (skippedNames: ReadonlyArray<string>) =>
    buildSkippedSkillsWarning({
      sessionId: "s-1",
      turnId: "t-1",
      harnessName: "Codex",
      skippedNames,
    });

  it("returns nothing when no skill was skipped", () => {
    expect(warn([])).toBeUndefined();
  });

  it("names one skipped skill in the turn of the input", () => {
    expect(warn(["review"])).toMatchObject({
      _tag: "runtime.warning",
      sessionId: "s-1",
      turnId: "t-1",
      message:
        "Hercule could not give Codex the skill $review: its SKILL.md is missing or leads outside the skill's folder. The message was sent without it.",
    });
  });

  it("lists every skipped skill in one warning", () => {
    expect(warn(["review", "webshop:release"])).toMatchObject({
      message:
        "Hercule could not give Codex the skills $review, $webshop:release: their SKILL.md files are missing or lead outside the skill's folder. The message was sent without them.",
    });
  });
});
