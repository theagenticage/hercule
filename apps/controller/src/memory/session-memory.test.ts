import { describe, expect, it } from "vitest";
import { renderSessionMemory } from "./session-memory";

describe("renderSessionMemory", () => {
  it("renders core in full and one line per topic, and says how to read a topic", () => {
    const text = renderSessionMemory("Rogier prefers short answers.", [
      { name: "core", gist: "", size: 29 },
      { name: "decisions", gist: "what we settled", size: 1_200 },
      { name: "people", gist: "", size: 40 },
    ]);
    expect(text).toBe(
      [
        "## Memory (core)",
        "",
        "Rogier prefers short answers.",
        "",
        "## Memory topics",
        "",
        "- decisions (1200 chars): what we settled",
        "- people (40 chars)",
        "",
        "2 of 24 topics. Read one in full with `hercule memory read me <name>`.",
      ].join("\n"),
    );
  });

  it("says when core is empty and when there are no topics", () => {
    const text = renderSessionMemory("", [{ name: "core", gist: "", size: 0 }]);
    expect(text).toContain("Your core memory is empty.");
    expect(text).toContain("You have no topics yet (0 of 24).");
    expect(text.indexOf("## Memory (core)")).toBeLessThan(text.indexOf("## Memory topics"));
  });
});
