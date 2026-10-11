import { describe, expect, it } from "vitest";
import type { Connection, IntakeSettings, PluginDetail } from "@hercule/contract";
import {
  applyIntakeChange,
  buildIntakeOverrides,
  canResetIntakeRow,
  describeIntakeSource,
  listIntakeSegments,
  listPluginsWithIntake,
} from "./intake-settings";

const NO_KINDS: IntakeSettings = { eventKinds: [], signalKinds: [] };

/** A plugin with the given Intake settings and one connection type per name in `types`. */
const buildPlugin = (
  id: string,
  displayName: string,
  types: ReadonlyArray<string>,
  intake: IntakeSettings,
): PluginDetail => ({
  id,
  displayName,
  hostApi: 1,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: types.map((type) => ({
    extensionPoint: "connection-type",
    id: type,
    definition: { type, displayName: type },
  })),
  intake,
});

const buildConnection = (id: string, type: string, label: string): Connection => ({
  id,
  type,
  label,
  displayName: label,
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const SETTINGS: IntakeSettings = {
  signalKinds: [
    { kind: "github/mentioned", label: "Mentioned", description: "", on: true, level: "default" },
    { kind: "github/assigned", label: "Assigned", description: "", on: false, level: "plugin" },
    {
      kind: "github/ci-failed",
      label: "CI failed",
      description: "",
      on: true,
      level: "connection",
    },
  ],
  eventKinds: [
    { kind: "github.push", description: "A push", on: false, level: "plugin" },
    { kind: "github.star", description: "A star", on: false, level: "default" },
  ],
};

describe("listPluginsWithIntake", () => {
  it("keeps the plugins that declare a signal kind or an event kind, in order", () => {
    const withSignals = buildPlugin("a", "A", [], {
      ...NO_KINDS,
      signalKinds: SETTINGS.signalKinds,
    });
    const withEvents = buildPlugin("b", "B", [], { ...NO_KINDS, eventKinds: SETTINGS.eventKinds });
    const withNothing = buildPlugin("c", "C", [], NO_KINDS);
    expect(listPluginsWithIntake([withEvents, withNothing, withSignals])).toEqual([
      withEvents,
      withSignals,
    ]);
  });
});

describe("listIntakeSegments", () => {
  const github = buildPlugin("github", "GitHub", ["github/account"], SETTINGS);

  it("puts All first, then one segment per Connection of the plugin", () => {
    const segments = listIntakeSegments(github, [
      buildConnection("c1", "github/account", "work"),
      buildConnection("c2", "gmail/account", "mail"),
      buildConnection("c3", "github/account", "personal"),
    ]);
    expect(segments).toEqual([
      { connectionId: undefined, label: "All GitHub connections" },
      { connectionId: "c1", label: "work" },
      { connectionId: "c3", label: "personal" },
    ]);
  });

  it("matches a Connection on a type the plugin declares, not on the plugin's id", () => {
    const declaresNoType = buildPlugin("github", "GitHub", [], SETTINGS);
    expect(
      listIntakeSegments(declaresNoType, [buildConnection("c1", "github/account", "work")]),
    ).toEqual([]);
  });

  it("is empty for a plugin with no Connection, so the section draws no control", () => {
    expect(listIntakeSegments(github, [buildConnection("c2", "gmail/account", "mail")])).toEqual(
      [],
    );
  });
});

describe("describeIntakeSource", () => {
  it("says nothing about a value that is the plugin's default", () => {
    expect(describeIntakeSource({ on: true, level: "default" }, "GitHub")).toBeNull();
  });

  it("names the plugin's connections for a choice made at the plugin's level", () => {
    expect(describeIntakeSource({ on: true, level: "plugin" }, "GitHub")).toBe(
      "On · all GitHub connections",
    );
    expect(describeIntakeSource({ on: false, level: "plugin" }, "GitHub")).toBe(
      "Off · all GitHub connections",
    );
  });

  it("says this connection for a choice made at the Connection's level", () => {
    expect(describeIntakeSource({ on: true, level: "connection" }, "GitHub")).toBe(
      "On · this connection",
    );
    expect(describeIntakeSource({ on: false, level: "connection" }, "GitHub")).toBe(
      "Off · this connection",
    );
  });
});

describe("canResetIntakeRow", () => {
  it("is true only for a choice made at the level the segment edits", () => {
    expect(canResetIntakeRow({ level: "plugin" }, "plugin")).toBe(true);
    expect(canResetIntakeRow({ level: "connection" }, "connection")).toBe(true);
    expect(canResetIntakeRow({ level: "default" }, "plugin")).toBe(false);
    expect(canResetIntakeRow({ level: "default" }, "connection")).toBe(false);
    expect(canResetIntakeRow({ level: "plugin" }, "connection")).toBe(false);
    expect(canResetIntakeRow({ level: "connection" }, "plugin")).toBe(false);
  });
});

describe("buildIntakeOverrides", () => {
  it("sends the choices stored at the edited level, with the new value added", () => {
    expect(
      buildIntakeOverrides(SETTINGS, "plugin", {
        list: "signalKinds",
        kind: "github/mentioned",
        on: false,
      }),
    ).toEqual({
      signalKinds: { "github/assigned": false, "github/mentioned": false },
      eventKinds: { "github.push": false },
    });
  });

  it("reads the choices of the Connection's level on a Connection segment", () => {
    expect(
      buildIntakeOverrides(SETTINGS, "connection", {
        list: "eventKinds",
        kind: "github.star",
        on: true,
      }),
    ).toEqual({
      signalKinds: { "github/ci-failed": true },
      eventKinds: { "github.star": true },
    });
  });

  it("replaces the choice of a kind the level already stores", () => {
    expect(
      buildIntakeOverrides(SETTINGS, "plugin", {
        list: "eventKinds",
        kind: "github.push",
        on: true,
      }).eventKinds,
    ).toEqual({ "github.push": true });
  });

  it("leaves the kind out for a change that takes its choice back", () => {
    expect(
      buildIntakeOverrides(SETTINGS, "plugin", {
        list: "signalKinds",
        kind: "github/assigned",
        on: null,
      }),
    ).toEqual({ signalKinds: {}, eventKinds: { "github.push": false } });
  });

  it("keeps a signal kind and an event kind of the same name apart", () => {
    const settings: IntakeSettings = {
      signalKinds: [{ kind: "same", label: "S", description: "", on: false, level: "plugin" }],
      eventKinds: [{ kind: "same", description: "E", on: false, level: "plugin" }],
    };
    expect(
      buildIntakeOverrides(settings, "plugin", { list: "eventKinds", kind: "same", on: null }),
    ).toEqual({ signalKinds: { same: false }, eventKinds: {} });
  });
});

describe("applyIntakeChange", () => {
  it("shows the new value as a choice of the edited level", () => {
    const shown = applyIntakeChange(SETTINGS, "connection", {
      list: "signalKinds",
      kind: "github/mentioned",
      on: false,
    });
    expect(shown.signalKinds[0]).toMatchObject({ on: false, level: "connection" });
    expect(shown.signalKinds.slice(1)).toEqual(SETTINGS.signalKinds.slice(1));
    expect(shown.eventKinds).toEqual(SETTINGS.eventKinds);
  });

  it("changes a row of the event list only when the change names that list", () => {
    const shown = applyIntakeChange(SETTINGS, "plugin", {
      list: "eventKinds",
      kind: "github.star",
      on: true,
    });
    expect(shown.eventKinds[1]).toMatchObject({ on: true, level: "plugin" });
    expect(shown.signalKinds).toEqual(SETTINGS.signalKinds);
  });

  it("leaves the settings alone for a change that takes a choice back", () => {
    expect(
      applyIntakeChange(SETTINGS, "plugin", {
        list: "signalKinds",
        kind: "github/assigned",
        on: null,
      }),
    ).toBe(SETTINGS);
  });
});
