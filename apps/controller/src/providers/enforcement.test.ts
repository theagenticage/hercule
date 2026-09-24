import { describe, expect, it } from "vitest";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { buildProviderDefinition } from "../plugins/testing";
import { listUnenforcedFields } from "./enforcement";

const ENFORCING: ProviderDefinition = buildProviderDefinition("claude-provider");

const IGNORING: ProviderDefinition = {
  ...buildProviderDefinition("codex-provider"),
  declared: { ...ENFORCING.declared, disallowedTools: "unsupported" },
};

const CATALOG: ReadonlyArray<ProviderDefinition> = [ENFORCING, IGNORING];

describe("listUnenforcedFields", () => {
  it("returns disallowedTools when the provider stores the list but does not enforce it", () => {
    expect(listUnenforcedFields(CATALOG, IGNORING.id, ["edit", "shell"])).toEqual([
      "disallowedTools",
    ]);
  });

  it("returns nothing when there is no restriction to ignore", () => {
    expect(listUnenforcedFields(CATALOG, IGNORING.id, [])).toEqual([]);
  });

  it("returns nothing when the provider enforces the restriction itself", () => {
    expect(listUnenforcedFields(CATALOG, ENFORCING.id, ["edit"])).toEqual([]);
  });

  it("returns nothing for a provider this build no longer has", () => {
    expect(listUnenforcedFields(CATALOG, "gone-provider", ["edit"])).toEqual([]);
  });
});
