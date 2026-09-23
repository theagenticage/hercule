import { describe, expect, it } from "vitest";
import type { PluginDetail } from "@hercule/contract";
import {
  listConnectionTypes,
  listCredentialFields,
  buildRedirectUri,
  decideSetupFlow,
  type ConnectionType,
} from "./connections";

describe("buildRedirectUri", () => {
  it("is the callback path on the origin the browser is at", () => {
    expect(buildRedirectUri("https://n.tail.ts.net")).toBe("https://n.tail.ts.net/oauth/callback");
  });

  it("does not double the slash when the origin carries a trailing one", () => {
    expect(buildRedirectUri("https://n.tail.ts.net/")).toBe("https://n.tail.ts.net/oauth/callback");
  });
});

/** A catalogued plugin, with whatever it contributes. */
const buildPlugin = (id: string, contributions: PluginDetail["contributions"]): PluginDetail => ({
  id,
  displayName: `Plugin ${id}`,
  hostApi: 1,
  capabilities: ["connections"],
  // Disabled: `register()` ran either way, so its types are still offered.
  enabled: false,
  status: { _tag: "active" },
  config: {},
  contributions,
});

const PAPER = {
  type: "paper-trail/paper",
  displayName: "Paper Trail",
  setup: [{ kind: "credentials", fields: [{ name: "token", label: "Access token" }] }],
  configSchema: { type: "object", properties: { folder: { type: "string" } } },
};

describe("listConnectionTypes", () => {
  it("is every connection-type contribution, and nothing else a plugin declares", () => {
    const types = listConnectionTypes([
      buildPlugin("paper-trail", [
        { extensionPoint: "connection-type", id: "paper-trail/paper", definition: PAPER },
      ]),
      buildPlugin("quiet-sink", [{ extensionPoint: "provider", id: "acme", definition: {} }]),
    ]);

    expect(types).toEqual([
      {
        type: "paper-trail/paper",
        displayName: "Paper Trail",
        pluginName: "Plugin paper-trail",
        setup: PAPER.setup,
        configSchema: PAPER.configSchema,
      },
    ]);
  });

  it("names two plugins declaring one word apart, by the type and by the plugin", () => {
    const buildGmailType = (displayName: string) => ({ type: "x", displayName, setup: [] });
    const types = listConnectionTypes([
      buildPlugin("first", [
        {
          extensionPoint: "connection-type",
          id: "first/gmail",
          definition: { ...buildGmailType("Gmail"), type: "first/gmail" },
        },
      ]),
      buildPlugin("second", [
        {
          extensionPoint: "connection-type",
          id: "second/gmail",
          definition: { ...buildGmailType("Gmail"), type: "second/gmail" },
        },
      ]),
    ]);

    expect(types.map((one) => [one.type, one.pluginName])).toEqual([
      ["first/gmail", "Plugin first"],
      ["second/gmail", "Plugin second"],
    ]);
  });
});

/** A type with just the setup under test; nothing else is read. */
const withSetup = (setup: ConnectionType["setup"]): ConnectionType => ({
  type: "p/t",
  displayName: "T",
  pluginName: "P",
  setup,
});

describe("decideSetupFlow", () => {
  it("is the one step that decides how the credential is obtained", () => {
    expect(
      decideSetupFlow(withSetup([{ kind: "checklist", markdown: "do this" }, { kind: "oauth" }])),
    ).toBe("oauth");
    expect(
      decideSetupFlow(
        withSetup([{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }]),
      ),
    ).toBe("credentials");
    expect(decideSetupFlow(withSetup([{ kind: "pairing" }]))).toBe("pairing");
  });

  it("prefers the redirect when a type declares both", () => {
    expect(
      decideSetupFlow(
        withSetup([
          { kind: "credentials", fields: [{ name: "token", label: "Token" }] },
          { kind: "oauth" },
        ]),
      ),
    ).toBe("oauth");
  });

  it("is unknown when nothing in the setup is a step this build can render", () => {
    expect(decideSetupFlow(withSetup([]))).toBe("unknown");
    expect(
      decideSetupFlow(
        withSetup([{ kind: "device-code" } as unknown as ConnectionType["setup"][number]]),
      ),
    ).toBe("unknown");
  });
});

describe("listCredentialFields", () => {
  it("is every declared field, in order, across the credential steps", () => {
    const fields = listCredentialFields(
      withSetup([
        { kind: "checklist", markdown: "first" },
        { kind: "credentials", fields: [{ name: "token", label: "Token", help: "paste it" }] },
        { kind: "credentials", fields: [{ name: "secret", label: "Secret" }] },
      ]),
    );

    expect(fields).toEqual([
      { name: "token", label: "Token", help: "paste it" },
      { name: "secret", label: "Secret" },
    ]);
  });

  it("is empty for a setup that asks the user to paste nothing", () => {
    expect(listCredentialFields(withSetup([{ kind: "oauth" }]))).toEqual([]);
  });
});
