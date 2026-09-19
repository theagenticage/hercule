import { describe, expect, it } from "vitest";
import type { ProviderDefinition } from "@hydra/plugin-host";
import { providerDefinition } from "../plugins/testing";
import { unenforcedFieldsIn } from "./enforcement";

const ENFORCING: ProviderDefinition = providerDefinition("claude-provider");

const IGNORING: ProviderDefinition = {
  ...providerDefinition("codex-provider"),
  declared: { ...ENFORCING.declared, disallowedTools: "unsupported" },
};

const CATALOG: ReadonlyArray<ProviderDefinition> = [ENFORCING, IGNORING];

describe("unenforcedFieldsIn", () => {
  it("names disallowedTools where the provider stores the list and acts on none of it", () => {
    expect(unenforcedFieldsIn(CATALOG, IGNORING.id, ["edit", "shell"])).toEqual([
      "disallowedTools",
    ]);
  });

  it("says nothing where there is no restriction to ignore", () => {
    expect(unenforcedFieldsIn(CATALOG, IGNORING.id, [])).toEqual([]);
  });

  it("says nothing where the provider enforces the restriction itself", () => {
    expect(unenforcedFieldsIn(CATALOG, ENFORCING.id, ["edit"])).toEqual([]);
  });

  it("says nothing for a provider this build no longer carries", () => {
    expect(unenforcedFieldsIn(CATALOG, "gone-provider", ["edit"])).toEqual([]);
  });
});
