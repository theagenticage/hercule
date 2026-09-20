import { describe, expect, it } from "vitest";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { providerDefinition } from "../plugins/testing";
import { listUnenforcedFields } from "./enforcement";

const ENFORCING: ProviderDefinition = providerDefinition("claude-provider");

const IGNORING: ProviderDefinition = {
  ...providerDefinition("codex-provider"),
  declared: { ...ENFORCING.declared, disallowedTools: "unsupported" },
};

const CATALOG: ReadonlyArray<ProviderDefinition> = [ENFORCING, IGNORING];

describe("listUnenforcedFields", () => {
  it("names disallowedTools where the provider stores the list and acts on none of it", () => {
    expect(listUnenforcedFields(CATALOG, IGNORING.id, ["edit", "shell"])).toEqual([
      "disallowedTools",
    ]);
  });

  it("says nothing where there is no restriction to ignore", () => {
    expect(listUnenforcedFields(CATALOG, IGNORING.id, [])).toEqual([]);
  });

  it("says nothing where the provider enforces the restriction itself", () => {
    expect(listUnenforcedFields(CATALOG, ENFORCING.id, ["edit"])).toEqual([]);
  });

  it("says nothing for a provider this build no longer carries", () => {
    expect(listUnenforcedFields(CATALOG, "gone-provider", ["edit"])).toEqual([]);
  });
});
