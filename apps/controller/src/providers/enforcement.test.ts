import { describe, expect, it } from "vitest";
import type { ProviderDefinition } from "@hydra/plugin-host";
import { providerDefinition } from "../plugins/testing";
import { unenforcedFieldsOf } from "./enforcement";

const ENFORCING: ProviderDefinition = providerDefinition("claude-provider");

const IGNORING: ProviderDefinition = {
  ...ENFORCING,
  declared: { ...ENFORCING.declared, disallowedTools: "unsupported" },
};

describe("unenforcedFieldsOf", () => {
  it("names disallowedTools where the provider stores the list and acts on none of it", () => {
    expect(unenforcedFieldsOf(IGNORING, ["edit", "shell"])).toEqual(["disallowedTools"]);
  });

  it("says nothing where there is no restriction to ignore", () => {
    expect(unenforcedFieldsOf(IGNORING, [])).toEqual([]);
  });

  it("says nothing where the provider enforces the restriction itself", () => {
    expect(unenforcedFieldsOf(ENFORCING, ["edit"])).toEqual([]);
  });
});
