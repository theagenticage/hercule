import { describe, expect, it } from "vitest";
import type { PluginDetail } from "@hercule/contract";
import {
  connectionTypes,
  credentialFieldsOf,
  redirectUriFor,
  setupFlowOf,
  type ConnectionType,
} from "./connections";

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

describe("connectionTypes", () => {
  it("is every connection-type contribution, and nothing else a plugin declares", () => {
    const types = connectionTypes([
      plugin("paper-trail", [
        { extensionPoint: "connection-type", id: "paper-trail/paper", definition: PAPER },
      ]),
      plugin("quiet-sink", [{ extensionPoint: "provider", id: "acme", definition: {} }]),
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
    const gmail = (displayName: string) => ({ type: "x", displayName, setup: [] });
    const types = connectionTypes([
      plugin("first", [
        {
          extensionPoint: "connection-type",
          id: "first/gmail",
          definition: { ...gmail("Gmail"), type: "first/gmail" },
        },
      ]),
      plugin("second", [
        {
          extensionPoint: "connection-type",
          id: "second/gmail",
          definition: { ...gmail("Gmail"), type: "second/gmail" },
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

describe("setupFlowOf", () => {
  it("is the one step that decides how the credential is obtained", () => {
    expect(
      setupFlowOf(withSetup([{ kind: "checklist", markdown: "do this" }, { kind: "oauth" }])),
    ).toBe("oauth");
    expect(
      setupFlowOf(
        withSetup([{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }]),
      ),
    ).toBe("credentials");
    expect(setupFlowOf(withSetup([{ kind: "pairing" }]))).toBe("pairing");
  });

  it("prefers the redirect when a type declares both", () => {
    expect(
      setupFlowOf(
        withSetup([
          { kind: "credentials", fields: [{ name: "token", label: "Token" }] },
          { kind: "oauth" },
        ]),
      ),
    ).toBe("oauth");
  });

  it("is unknown when nothing in the setup is a step this build can render", () => {
    expect(setupFlowOf(withSetup([]))).toBe("unknown");
    expect(
      setupFlowOf(
        withSetup([{ kind: "device-code" } as unknown as ConnectionType["setup"][number]]),
      ),
    ).toBe("unknown");
  });
});

describe("credentialFieldsOf", () => {
  it("is every declared field, in order, across the credential steps", () => {
    const fields = credentialFieldsOf(
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
    expect(credentialFieldsOf(withSetup([{ kind: "oauth" }]))).toEqual([]);
  });
});
