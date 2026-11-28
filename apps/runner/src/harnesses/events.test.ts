/** Tests the events adapters report themselves about an input: its `user_message` and the skipped-skills warning. */
import { describe, expect, it } from "vitest";
import { buildUserMessage } from "./events";

const base = { sessionId: "s-1", turnId: "t-1", text: "hi", steered: false } as const;

/** Returns the `detail` of the completed item. */
const readDetail = (input: Parameters<typeof buildUserMessage>[0]): unknown => {
  const completed = buildUserMessage(input)[1]!;
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

  describe("the skipped-skills warning", () => {
    const build = (names: ReadonlyArray<string>) =>
      buildUserMessage({ ...base, skippedSkills: { harnessName: "Codex", names } });

    it("returns only the message when no skill was skipped", () => {
      expect(buildUserMessage(base).map((event) => event._tag)).toEqual([
        "item.started",
        "item.completed",
      ]);
      expect(build([]).map((event) => event._tag)).toEqual(["item.started", "item.completed"]);
    });

    it("follows the message, in the turn of the input, and names one skipped skill", () => {
      const events = build(["review"]);
      expect(events.map((event) => event._tag)).toEqual([
        "item.started",
        "item.completed",
        "runtime.warning",
      ]);
      expect(events[2]).toMatchObject({
        sessionId: "s-1",
        turnId: "t-1",
        message:
          "Hercule could not give Codex the skill $review: its SKILL.md is missing, is not a regular file, or leads outside the skill's folder. The message was sent without it. Check the skill's folder, then send the message again.",
      });
    });

    it("lists every skipped skill in one warning", () => {
      const events = build(["review", "webshop:release"]);
      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({
        message:
          "Hercule could not give Codex the skills $review, $webshop:release: their SKILL.md files are missing, are not regular files, or lead outside the skills' folders. The message was sent without them. Check the skills' folders, then send the message again.",
      });
    });
  });
});
