import { describe, expect, it } from "vitest";
import type { PluginDetail } from "@hydra/contract";
import { connectionTypes, redirectUriFor } from "./connections";

describe("redirectUriFor", () => {
  it("is the callback path on the origin the browser is at", () => {
    expect(redirectUriFor("https://n.tail.ts.net")).toBe("https://n.tail.ts.net/oauth/callback");
  });

  it("does not double the slash when the origin carries a trailing one", () => {
    expect(redirectUriFor("https://n.tail.ts.net/")).toBe("https://n.tail.ts.net/oauth/callback");
  });
});

/** A catalogued plugin, with whatever it contributes. */
const plugin = (id: string, contributions: PluginDetail["contributions"]): PluginDetail => ({
  id,
  displayName: id,
  hostApi: 1,
  capabilities: ["connections"],
  // Disabled: `register()` ran either way, so its types are still offered.
  enabled: false,
  status: { _tag: "active" },
  config: {},
  contributions,
});

const PAPER = {
  type: "paper",
  displayName: "Paper Trail",
  setup: [{ kind: "credentials", fields: [{ name: "token", label: "Access token" }] }],
  configSchema: { type: "object", properties: { folder: { type: "string" } } },
};

describe("connectionTypes", () => {
  it("is every connection-type contribution, and nothing else a plugin declares", () => {
    const types = connectionTypes([
      plugin("paper-trail", [
        { extensionPoint: "connection-type", id: "paper", definition: PAPER },
      ]),
      plugin("quiet-sink", [{ extensionPoint: "provider", id: "acme", definition: {} }]),
    ]);

    expect(types).toEqual([
      {
        type: "paper",
        displayName: "Paper Trail",
        setup: PAPER.setup,
        configSchema: PAPER.configSchema,
      },
    ]);
  });
});
