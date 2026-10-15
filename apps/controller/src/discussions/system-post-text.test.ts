import { describe, expect, it } from "vitest";
import { countCharacters, MAX_POST_LENGTH } from "@hercule/contract";
import { buildSystemPostText, MAX_NAMED_FILES, type SystemPostChanges } from "./system-post-text";

const ID = "0199e0e7-0000-7000-8000-0000deadbeef";

const idNumber = (n: number) => `0199e0e7-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("buildSystemPostText", () => {
  it("returns undefined when nothing changed", () => {
    expect(
      buildSystemPostText({ files: [], notTold: new Map(), leftOut: new Set(), links: [] }),
    ).toBeUndefined();
  });

  it("counts one left-out session in the singular and several in the plural", () => {
    const base = { files: [], notTold: new Map(), links: [] };
    expect(buildSystemPostText({ ...base, leftOut: new Set([ID]) })).toBe(
      "1 more session edited these files but was left out: this discussion has 50 participants.",
    );
    expect(buildSystemPostText({ ...base, leftOut: new Set([ID, "b"]) })).toBe(
      "2 more sessions edited these files but were left out: this discussion has 50 participants.",
    );
  });

  it("stays within MAX_POST_LENGTH in the worst case", () => {
    const worst: SystemPostChanges = {
      files: Array.from({ length: MAX_NAMED_FILES * 5 }, (_, i) => ({
        path: `${"x".repeat(300)}${i}`,
        sessionIds: Array.from({ length: 500 }, (_, s) => idNumber(s)),
      })),
      notTold: new Map(
        Array.from({ length: 500 }, (_, i) => [idNumber(i), "lacks_grants"] as const),
      ),
      leftOut: new Set(Array.from({ length: 5000 }, (_, i) => idNumber(i))),
      links: Array.from({ length: 500 }, (_, i) => ({
        sessionId: idNumber(i),
        discussionId: idNumber(i + 1000),
        subject: "s".repeat(400),
      })),
    };
    const text = buildSystemPostText(worst);
    expect(text).toBeDefined();
    expect(countCharacters(text ?? "")).toBeLessThanOrEqual(MAX_POST_LENGTH);
  });
});
