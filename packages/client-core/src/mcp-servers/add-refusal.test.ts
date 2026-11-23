import { describe, expect, it } from "vitest";
import type { Connection, PluginDetail } from "@hercule/contract";
import { describeExistsRefusal, describePluginOriginRefusal } from "./add-refusal";
import {
  CONNECTIONS,
  OFFERING_PLUGINS,
  SENTRY_HOBBY_CONNECTION,
  SENTRY_WORK_CONNECTION,
} from "./testing";

describe("describeExistsRefusal", () => {
  it("names the server added before, with a button that opens it", () => {
    expect(describeExistsRefusal("s-docs", { kind: "found", name: "docs" })).toEqual({
      sentence: [
        { text: "You added this server before, as ", code: false },
        { text: "docs", code: true },
        { text: ". One address is one server.", code: false },
      ],
      action: { kind: "open-server", mcpServerId: "s-docs", label: "Open docs" },
    });
  });

  it.each(["reading", "unknown"] as const)(
    "leaves the name out while the record is %s, and still opens it by id",
    (kind) => {
      expect(describeExistsRefusal("s-docs", { kind })).toEqual({
        sentence: [
          { text: "You added this server before. One address is one server.", code: false },
        ],
        action: { kind: "open-server", mcpServerId: "s-docs", label: "Open server" },
      });
    },
  );

  it("says the server is gone and offers no button for a record that does not exist", () => {
    expect(describeExistsRefusal("s-docs", { kind: "gone" })).toEqual({
      sentence: [
        {
          text: "You added this server before, but it was removed since. Check the server again to add it.",
          code: false,
        },
      ],
      action: null,
    });
  });
});

describe("describePluginOriginRefusal", () => {
  const MESSAGE = "This address is the Sentry plugin's server.";
  const OFFERS =
    "The Sentry plugin already offers this server. It is reached with a Sentry Connection, with no second sign-in, so it is not added by hand.";
  const refusal = (connectionId: string | null) => ({
    contributionId: "sentry/sentry",
    connectionId,
  });
  const describe_ = (
    overrides: {
      plugins?: readonly PluginDetail[] | undefined;
      connections?: readonly Connection[] | undefined;
      connectionId?: string | null;
    } = {},
  ) =>
    describePluginOriginRefusal({
      refusal: refusal("connectionId" in overrides ? overrides.connectionId! : "c-work"),
      message: MESSAGE,
      plugins: "plugins" in overrides ? overrides.plugins : OFFERING_PLUGINS,
      connections: "connections" in overrides ? overrides.connections : CONNECTIONS,
    });
  const withSentry = (patch: Partial<PluginDetail>): PluginDetail[] => [
    { ...OFFERING_PLUGINS[0]!, ...patch },
    OFFERING_PLUGINS[1]!,
  ];

  it("points at the exact row of the offer on a connected Connection", () => {
    expect(describe_()).toEqual({
      sentence: [{ text: OFFERS, code: false }],
      action: {
        kind: "open-offer-row",
        contributionId: "sentry/sentry",
        connectionId: "c-work",
        label: "Show Sentry · work",
      },
    });
  });

  it("points at a connected Connection when the one the controller named needs attention", () => {
    const connections = [
      { ...SENTRY_WORK_CONNECTION, status: "needs-reauth" as const },
      SENTRY_HOBBY_CONNECTION,
    ];

    expect(describe_({ connections })).toMatchObject({
      action: { kind: "open-offer-row", connectionId: "c-hobby" },
    });
  });

  it("points at a Connection the user made since, when the controller named none", () => {
    expect(describe_({ connectionId: null })).toMatchObject({
      action: { kind: "open-offer-row", connectionId: "c-work" },
    });
  });

  it("sends the user to Connections when every Connection of the type needs attention", () => {
    const connections = [
      { ...SENTRY_WORK_CONNECTION, status: "disabled" as const },
      { ...SENTRY_HOBBY_CONNECTION, status: "error" as const },
    ];

    expect(describe_({ connections })).toEqual({
      sentence: [
        {
          text: `${OFFERS} The Sentry Connection work needs attention first. Fix it in Settings > Connections, then switch its server on.`,
          code: false,
        },
      ],
      action: { kind: "open-connections", label: "Open Connections" },
    });
  });

  it("says to connect first when the user has no Connection of the type", () => {
    expect(describe_({ connections: [], connectionId: null })).toEqual({
      sentence: [
        {
          text: `${OFFERS} Connect Sentry first in Settings > Connections, then switch its server on.`,
          code: false,
        },
      ],
      action: { kind: "open-connections", label: "Open Connections" },
    });
  });

  it("points a switched-off plugin at Settings > Plugins, even with a Connection", () => {
    expect(describe_({ plugins: withSentry({ enabled: false }) })).toEqual({
      sentence: [
        {
          text: `${OFFERS} Switch the Sentry plugin on in Settings > Plugins to use it.`,
          code: false,
        },
      ],
      action: { kind: "open-plugins", label: "Open Plugins" },
    });
  });

  it("points a plugin that is on and did not start at Settings > Plugins", () => {
    expect(
      describe_({ plugins: withSentry({ status: { _tag: "errored", message: "boom" } }) }),
    ).toEqual({
      sentence: [
        {
          text: `${OFFERS} The Sentry plugin is switched on but did not start. See Settings > Plugins.`,
          code: false,
        },
      ],
      action: { kind: "open-plugins", label: "Open Plugins" },
    });
  });

  it("uses the plugin's state now, not the one the controller saw", () => {
    // The controller saw the plugin switched off. It runs now, so the row is there to open.
    expect(describe_()).toMatchObject({ action: { kind: "open-offer-row" } });
  });

  it.each([
    ["the plugins are not read", { plugins: undefined }],
    ["the Connections are not read", { connections: undefined }],
    ["the plugin is gone", { plugins: [OFFERING_PLUGINS[1]!] }],
    ["the plugin no longer offers the server", { plugins: withSentry({ contributions: [] }) }],
  ])("says the controller's own sentence, with no button, when %s", (_what, overrides) => {
    expect(describe_(overrides)).toEqual({
      sentence: [{ text: MESSAGE, code: false }],
      action: null,
    });
  });
});
