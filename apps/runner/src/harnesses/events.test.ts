/** Tests the `user_message` item that adapters record for an input. */
import { describe, expect, it } from "vitest";
import { buildUserMessage } from "./events";

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
