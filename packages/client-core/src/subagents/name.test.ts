/** Tests the name a screen shows for a subagent: `nameSubagent`. */
import { describe, expect, it } from "vitest";
import { nameSubagent } from "./name";
import { buildSubagent } from "./subagents.testing";

describe("nameSubagent", () => {
  it("names a subagent by its description", () => {
    expect(
      nameSubagent(buildSubagent({ id: "a", description: "Read the docs", agentType: "Explore" })),
    ).toBe("Read the docs");
  });

  it("falls back to its agent type, then to Subagent, while it has no description", () => {
    expect(nameSubagent(buildSubagent({ id: "a", agentType: "Explore" }))).toBe("Explore");
    expect(nameSubagent(buildSubagent({ id: "a" }))).toBe("Subagent");
  });
});
