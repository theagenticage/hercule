import { describe, expect, it } from "vitest";
import type { PluginDetail } from "@hercule/contract";
import {
  listConnectionTypes,
  listCredentialFields,
  listSetupFlows,
  showsPluginName,
  type ConnectionType,
} from "./connection-types";

const buildPlugin = (id: string, contributions: PluginDetail["contributions"]): PluginDetail => ({
  id,
  displayName: `Plugin ${id}`,
  hostApi: 1,
  capabilities: ["connections"],
  // Disabled, but `register()` still ran, so its types are still offered.
  enabled: false,
  status: { _tag: "active" },
  config: {},
  contributions,
  intake: { eventKinds: [], signalKinds: [] },
});

const PAPER = {
  type: "paper-trail/paper",
  displayName: "Paper Trail",
  setup: [{ kind: "credentials", fields: [{ name: "token", label: "Access token" }] }],
  configSchema: { type: "object", properties: { folder: { type: "string" } } },
};

describe("listConnectionTypes", () => {
  it("returns every connection-type contribution, and no other contribution", () => {
    const types = listConnectionTypes([
      buildPlugin("paper-trail", [
        { extensionPoint: "connection-type", id: "paper-trail/paper", definition: PAPER },
      ]),
      buildPlugin("quiet-sink", [{ extensionPoint: "harness", id: "acme", definition: {} }]),
    ]);

    expect(types).toEqual([
      {
        type: "paper-trail/paper",
        displayName: "Paper Trail",
        pluginName: "Plugin paper-trail",
        setup: PAPER.setup,
        hasPublicClient: false,
        configSchema: PAPER.configSchema,
        feeds: [],
      },
    ]);
  });

  it("marks a type whose plugin ships a public client for its redirect flow", () => {
    const oauth = {
      authorizationUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      scopes: ["read"],
    };
    const [shipped, own] = listConnectionTypes([
      buildPlugin("linear", [
        {
          extensionPoint: "connection-type",
          id: "linear/linear",
          definition: {
            type: "linear/linear",
            displayName: "Linear",
            setup: [{ kind: "oauth" }],
            oauth: {
              ...oauth,
              publicClient: {
                clientId: "public",
                redirectUris: ["http://127.0.0.1:4937/oauth/callback"],
              },
            },
          },
        },
        {
          extensionPoint: "connection-type",
          id: "linear/own",
          definition: { type: "linear/own", displayName: "Own", setup: [{ kind: "oauth" }], oauth },
        },
      ]),
    ]);

    expect(shipped?.hasPublicClient).toBe(true);
    expect(own?.hasPublicClient).toBe(false);
  });

  it("gives a type the feeds of the event source that polls for it", () => {
    const [paper] = listConnectionTypes([
      buildPlugin("paper-trail", [
        { extensionPoint: "connection-type", id: "paper-trail/paper", definition: PAPER },
        {
          extensionPoint: "event-source",
          id: "paper-trail/inbox",
          definition: {
            connectionType: "paper-trail/paper",
            kinds: {},
            feeds: {
              letters: { defaultIntervalSeconds: 120, minIntervalSeconds: 60 },
              parcels: { defaultIntervalSeconds: 300 },
            },
          },
        },
        // Polls for another type, so its feed is not the paper type's.
        {
          extensionPoint: "event-source",
          id: "paper-trail/fax",
          definition: { connectionType: "paper-trail/fax", kinds: {}, feeds: { pages: {} } },
        },
      ]),
    ]);

    expect(paper?.feeds).toEqual([
      { name: "letters", defaultIntervalSeconds: 120, minIntervalSeconds: 60 },
      // No minimum declared, so the default is the shortest interval allowed.
      { name: "parcels", defaultIntervalSeconds: 300, minIntervalSeconds: 300 },
    ]);
  });

  it("leaves out a feed whose declaration it cannot read", () => {
    const [paper] = listConnectionTypes([
      buildPlugin("paper-trail", [
        { extensionPoint: "connection-type", id: "paper-trail/paper", definition: PAPER },
        {
          extensionPoint: "event-source",
          id: "paper-trail/inbox",
          definition: {
            connectionType: "paper-trail/paper",
            feeds: {
              letters: { defaultIntervalSeconds: 120 },
              noDefault: { minIntervalSeconds: 60 },
              textMinimum: { defaultIntervalSeconds: 60, minIntervalSeconds: "30" },
              notAnObject: 60,
            },
          },
        },
        {
          extensionPoint: "event-source",
          id: "paper-trail/broken",
          definition: { connectionType: "paper-trail/paper", feeds: ["letters"] },
        },
      ]),
    ]);

    expect(paper?.feeds.map((feed) => feed.name)).toEqual(["letters"]);
  });

  it("tells apart two plugins that declare a type with the same name, by type and by plugin", () => {
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

/** Returns a connection type with only the setup under test; no other field is read. */
const withSetup = (setup: ConnectionType["setup"]): ConnectionType => ({
  type: "p/t",
  displayName: "T",
  pluginName: "P",
  setup,
  hasPublicClient: false,
  feeds: [],
});

describe("showsPluginName", () => {
  it("is true when the plugin's name differs from the type's", () => {
    expect(showsPluginName(withSetup([]))).toBe(true);
  });

  it("is false when the plugin is named like its type", () => {
    expect(showsPluginName({ ...withSetup([]), displayName: "GitHub", pluginName: "GitHub" })).toBe(
      false,
    );
  });
});

describe("listSetupFlows", () => {
  it("returns the one flow a type with a single step offers", () => {
    expect(
      listSetupFlows(withSetup([{ kind: "checklist", markdown: "do this" }, { kind: "oauth" }])),
    ).toEqual(["oauth"]);
    expect(
      listSetupFlows(
        withSetup([{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }]),
      ),
    ).toEqual(["credentials"]);
    expect(listSetupFlows(withSetup([{ kind: "device" }]))).toEqual(["device"]);
    expect(listSetupFlows(withSetup([{ kind: "pairing" }]))).toEqual(["pairing"]);
  });

  it("returns every flow a type offers, in the order its setup declares them", () => {
    const token = { kind: "credentials", fields: [{ name: "token", label: "Token" }] } as const;
    expect(listSetupFlows(withSetup([{ kind: "device" }, token]))).toEqual([
      "device",
      "credentials",
    ]);
    expect(listSetupFlows(withSetup([token, { kind: "oauth" }]))).toEqual(["credentials", "oauth"]);
  });

  it("returns one credentials flow for several credential steps", () => {
    expect(
      listSetupFlows(
        withSetup([
          { kind: "credentials", fields: [{ name: "token", label: "Token" }] },
          { kind: "credentials", fields: [{ name: "secret", label: "Secret" }] },
        ]),
      ),
    ).toEqual(["credentials"]);
  });

  it("leaves out a step kind this build does not know", () => {
    const unknown = { kind: "carrier-pigeon" } as unknown as ConnectionType["setup"][number];
    expect(listSetupFlows(withSetup([]))).toEqual([]);
    expect(listSetupFlows(withSetup([unknown]))).toEqual([]);
    expect(listSetupFlows(withSetup([unknown, { kind: "device" }]))).toEqual(["device"]);
  });
});

describe("listCredentialFields", () => {
  it("returns every declared field, in order, across the credential steps", () => {
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

  it("returns no fields for a setup that asks the user to paste nothing", () => {
    expect(listCredentialFields(withSetup([{ kind: "oauth" }]))).toEqual([]);
  });
});
