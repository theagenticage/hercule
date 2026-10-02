import { describe, expect, it } from "vitest";
import type { Connection, PluginDetail } from "@hercule/contract";
import {
  listConnectionTypes,
  listCredentialFields,
  showsAccountBesideLabel,
  showsPluginName,
  buildTopicsUpdate,
  buildRedirectUri,
  listSetupFlows,
  decideDeviceFlowStep,
  type ConnectionType,
} from "./connections";

describe("showsAccountBesideLabel", () => {
  const connection = {
    id: "0199c0ff-aaaa-7000-8000-000000000001",
    type: "github/github",
    label: "octocat",
    displayName: "octocat",
    status: "connected",
    labels: [],
    config: {},
    credentials: [],
    createdAt: "2026-10-02T08:15:00.000Z",
    updatedAt: "2026-10-02T08:15:00.000Z",
  } satisfies Connection;

  it("is false for a connection whose name is its account name", () => {
    expect(showsAccountBesideLabel(connection)).toBe(false);
  });

  it("is true once the connection is renamed, though the account stays the same", () => {
    expect(showsAccountBesideLabel({ ...connection, label: "personal" })).toBe(true);
  });

  it("is false for an account with no name, which the type's name stands in for", () => {
    expect(showsAccountBesideLabel({ ...connection, label: "GitHub", displayName: "" })).toBe(
      false,
    );
    expect(showsAccountBesideLabel({ ...connection, label: "GitHub", displayName: "  " })).toBe(
      false,
    );
  });
});

describe("buildTopicsUpdate", () => {
  it("returns nothing when the first topic is unchanged", () => {
    expect(buildTopicsUpdate(["Code", "Ops"], "Code")).toBeUndefined();
    expect(buildTopicsUpdate([], "")).toBeUndefined();
  });

  it("replaces the first topic and keeps the others", () => {
    expect(buildTopicsUpdate(["Code", "Ops"], "Business")).toEqual(["Business", "Ops"]);
    expect(buildTopicsUpdate([], "Code")).toEqual(["Code"]);
  });

  it("removes only the first topic when the field is cleared", () => {
    expect(buildTopicsUpdate(["Code", "Ops"], "")).toEqual(["Ops"]);
    expect(buildTopicsUpdate(["Code"], "")).toEqual([]);
  });

  it("trims the typed topic, and reads text of only spaces as cleared", () => {
    expect(buildTopicsUpdate(["Code", "Ops"], " Code ")).toBeUndefined();
    expect(buildTopicsUpdate(["Code", "Ops"], "Business ")).toEqual(["Business", "Ops"]);
    expect(buildTopicsUpdate(["Code", "Ops"], "   ")).toEqual(["Ops"]);
    expect(buildTopicsUpdate([], "   ")).toBeUndefined();
  });

  it("lists a topic once when the new first topic is one of the others", () => {
    expect(buildTopicsUpdate(["Code", "Ops"], "Ops")).toEqual(["Ops"]);
  });
});

describe("buildRedirectUri", () => {
  it("is the callback path on the browser's origin", () => {
    expect(buildRedirectUri("https://n.tail.ts.net")).toBe("https://n.tail.ts.net/oauth/callback");
  });

  it("does not double the slash when the origin ends in one", () => {
    expect(buildRedirectUri("https://n.tail.ts.net/")).toBe("https://n.tail.ts.net/oauth/callback");
  });
});

/** Returns a plugin from the plugin list, with the given contributions. */
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

describe("decideDeviceFlowStep", () => {
  const deviceStart = {
    setupId: "s-1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://example.test/device",
    expiresAt: "2026-10-02T12:15:00.000Z",
    interval: 5,
  };

  it("waits the start's interval before the first poll", () => {
    expect(decideDeviceFlowStep(deviceStart, undefined)).toEqual({
      kind: "waiting",
      status: "pending",
      delay: 5000,
    });
  });

  it("waits the interval the last reply returned while the flow is open", () => {
    expect(decideDeviceFlowStep(deviceStart, { status: "pending", interval: 5 })).toEqual({
      kind: "waiting",
      status: "pending",
      delay: 5000,
    });
    expect(decideDeviceFlowStep(deviceStart, { status: "slow-down", interval: 10 })).toEqual({
      kind: "waiting",
      status: "slow-down",
      delay: 10_000,
    });
    expect(decideDeviceFlowStep(deviceStart, { status: "unreachable", interval: 5 })).toEqual({
      kind: "waiting",
      status: "unreachable",
      delay: 5000,
    });
  });

  it("ends the flow with the controller's reason", () => {
    for (const status of ["expired", "denied", "failed"] as const) {
      const message = "the code expired before it was approved";
      expect(decideDeviceFlowStep(deviceStart, { status, message })).toEqual({
        kind: "ended",
        status,
        message,
      });
    }
  });

  it("returns the new connection once the flow is done", () => {
    // The connection is passed through untouched, so any record will do.
    const connection = {} as Connection;
    expect(decideDeviceFlowStep(deviceStart, { status: "done", connection })).toEqual({
      kind: "done",
      connection,
    });
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
