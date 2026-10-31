import { describe, expect, it } from "vitest";
import type { RegisteredHarness } from "../plugins";
import { buildHarnessDefinition } from "../plugins/testing";
import { listUnenforcedFields } from "./enforcement";

const ENFORCING: RegisteredHarness = buildHarnessDefinition("claude");

const IGNORING: RegisteredHarness = {
  ...buildHarnessDefinition("codex"),
  declared: { ...ENFORCING.declared, disallowedTools: "unsupported" },
};

const CATALOG: ReadonlyArray<RegisteredHarness> = [ENFORCING, IGNORING];

describe("listUnenforcedFields", () => {
  it("returns disallowedTools when the harness stores the list but does not enforce it", () => {
    expect(listUnenforcedFields(CATALOG, IGNORING.id, ["edit", "shell"])).toEqual([
      "disallowedTools",
    ]);
  });

  it("returns nothing when there is no restriction to ignore", () => {
    expect(listUnenforcedFields(CATALOG, IGNORING.id, [])).toEqual([]);
  });

  it("returns nothing when the harness enforces the restriction itself", () => {
    expect(listUnenforcedFields(CATALOG, ENFORCING.id, ["edit"])).toEqual([]);
  });

  it("returns nothing for a harness this build no longer has", () => {
    expect(listUnenforcedFields(CATALOG, "gone", ["edit"])).toEqual([]);
  });
});
