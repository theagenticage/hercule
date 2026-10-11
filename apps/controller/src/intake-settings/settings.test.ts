/**
 * Tests the pure rules of Intake settings:
 *
 * - the default of each kind comes from the plugin's declaration;
 * - a plugin's choice and a Connection's choice are layered on it, the
 *   Connection's winning;
 * - a write drops the entries that equal the level below, and refuses a kind
 *   the plugin does not declare;
 * - an entry for a kind the plugin no longer declares is ignored on read.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { IntakeOverrides } from "@hercule/contract";
import {
  applyIntakeOverrides,
  buildDefaultIntakeSettings,
  normalizeIntakeOverrides,
  NO_INTAKE_OVERRIDES,
  type DeclaredIntakeKinds,
} from "./settings";

const declared: DeclaredIntakeKinds = {
  eventKinds: [
    { kind: "pr.opened", description: "A pull request was opened.", availableToTriage: true },
    { kind: "pr.labeled", description: "A label was added.", availableToTriage: false },
  ],
  signalKinds: [
    {
      kind: "github/team-review-requested",
      label: "Team review requested",
      description: "A review was requested from your team.",
    },
    {
      kind: "github/review-requested",
      label: "Review requested",
      description: "A review was requested from you.",
    },
  ],
};

const defaults = buildDefaultIntakeSettings(declared);

const onOf = (
  settings: ReadonlyArray<{ readonly kind: string; readonly on: boolean; readonly level: string }>,
) => Object.fromEntries(settings.map(({ kind, on, level }) => [kind, `${on}@${level}`]));

describe("buildDefaultIntakeSettings", () => {
  it("makes an event kind as available as the plugin declared it, and every signal kind on", () => {
    expect(onOf(defaults.eventKinds)).toEqual({
      "pr.opened": "true@default",
      "pr.labeled": "false@default",
    });
    expect(onOf(defaults.signalKinds)).toEqual({
      "github/team-review-requested": "true@default",
      "github/review-requested": "true@default",
    });
  });

  it("keeps the declared order and the texts", () => {
    expect(defaults.eventKinds.map(({ kind }) => kind)).toEqual(["pr.opened", "pr.labeled"]);
    expect(defaults.signalKinds[0]).toMatchObject({
      label: "Team review requested",
      description: "A review was requested from your team.",
    });
  });

  it("is empty for a plugin that declares nothing", () => {
    expect(buildDefaultIntakeSettings({ eventKinds: [], signalKinds: [] })).toEqual({
      eventKinds: [],
      signalKinds: [],
    });
  });
});

describe("applyIntakeOverrides", () => {
  it("gives the plugin's choice the plugin level, and leaves other kinds at the default", () => {
    const plugin = applyIntakeOverrides(
      defaults,
      {
        eventKinds: { "pr.labeled": true },
        signalKinds: { "github/team-review-requested": false },
      },
      "plugin",
    );
    expect(onOf(plugin.eventKinds)).toEqual({
      "pr.opened": "true@default",
      "pr.labeled": "true@plugin",
    });
    expect(onOf(plugin.signalKinds)).toEqual({
      "github/team-review-requested": "false@plugin",
      "github/review-requested": "true@default",
    });
  });

  it("lets a Connection's choice win over the plugin's", () => {
    // team-review-requested is off for the plugin and on for the "work"
    // Connection. The "personal" Connection chose nothing and follows the plugin.
    const plugin = applyIntakeOverrides(
      defaults,
      { eventKinds: {}, signalKinds: { "github/team-review-requested": false } },
      "plugin",
    );
    const work = applyIntakeOverrides(
      plugin,
      { eventKinds: {}, signalKinds: { "github/team-review-requested": true } },
      "connection",
    );
    const personal = applyIntakeOverrides(plugin, NO_INTAKE_OVERRIDES, "connection");
    expect(onOf(work.signalKinds)["github/team-review-requested"]).toBe("true@connection");
    expect(onOf(personal.signalKinds)["github/team-review-requested"]).toBe("false@plugin");
  });

  it("ignores an entry for a kind the plugin no longer declares", () => {
    const applied = applyIntakeOverrides(
      defaults,
      { eventKinds: { "pr.removed": true }, signalKinds: { "github/removed": false } },
      "plugin",
    );
    expect(applied).toEqual(defaults);
  });

  it("does not treat an object property name as an entry", () => {
    const applied = applyIntakeOverrides(
      buildDefaultIntakeSettings({
        eventKinds: [{ kind: "toString", description: "", availableToTriage: true }],
        signalKinds: [],
      }),
      NO_INTAKE_OVERRIDES,
      "plugin",
    );
    expect(applied.eventKinds[0]).toMatchObject({ on: true, level: "default" });
  });
});

describe("normalizeIntakeOverrides", () => {
  const normalize = (written: IntakeOverrides, below = defaults) =>
    Effect.runSyncExit(normalizeIntakeOverrides(written, below));

  it("stores an entry that differs from the level below", () => {
    expect(
      normalize({
        eventKinds: { "pr.labeled": true },
        signalKinds: { "github/review-requested": false },
      }),
    ).toEqual(
      Exit.succeed({
        eventKinds: { "pr.labeled": true },
        signalKinds: { "github/review-requested": false },
      }),
    );
  });

  it("drops an entry equal to the level below", () => {
    // pr.opened is already on, and the signal kind is already on.
    expect(
      normalize({
        eventKinds: { "pr.opened": true, "pr.labeled": false },
        signalKinds: { "github/review-requested": true },
      }),
    ).toEqual(Exit.succeed({ eventKinds: {}, signalKinds: {} }));
  });

  it("compares with the value in effect below, not with the default", () => {
    const plugin = applyIntakeOverrides(
      defaults,
      { eventKinds: { "pr.labeled": true }, signalKinds: {} },
      "plugin",
    );
    // For a Connection, "on" now equals the plugin's value and is dropped.
    // "off" differs from it and is stored, though it equals the default.
    expect(normalize({ eventKinds: { "pr.labeled": true }, signalKinds: {} }, plugin)).toEqual(
      Exit.succeed({ eventKinds: {}, signalKinds: {} }),
    );
    expect(normalize({ eventKinds: { "pr.labeled": false }, signalKinds: {} }, plugin)).toEqual(
      Exit.succeed({ eventKinds: { "pr.labeled": false }, signalKinds: {} }),
    );
  });

  it("stores nothing when a kind is toggled on and then off", () => {
    // Turning pr.labeled on stores an entry; turning it off writes the whole
    // level again with the entry equal to the default, which drops it.
    const on = Effect.runSync(
      normalizeIntakeOverrides({ eventKinds: { "pr.labeled": true }, signalKinds: {} }, defaults),
    );
    expect(on.eventKinds).toEqual({ "pr.labeled": true });
    const off = Effect.runSync(
      normalizeIntakeOverrides({ eventKinds: { "pr.labeled": false }, signalKinds: {} }, defaults),
    );
    expect(off).toEqual({ eventKinds: {}, signalKinds: {} });
  });

  it("refuses a kind the plugin does not declare, with a path per kind", () => {
    const exit = normalize({
      eventKinds: { "pr.unknown": true },
      signalKinds: { "github/unknown": false },
    });
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "";
    expect(error).toContain("intake");
    expect(error).toContain("pr.unknown");
    expect(error).toContain("github/unknown");
    expect(error).toContain("Choose from pr.opened, pr.labeled.");
    expect(error).toContain("Choose from github/team-review-requested, github/review-requested.");
  });

  it("says there is nothing to choose for a plugin that declares no kinds", () => {
    const exit = normalize(
      { eventKinds: { "pr.opened": true }, signalKinds: {} },
      buildDefaultIntakeSettings({ eventKinds: [], signalKinds: [] }),
    );
    expect(JSON.stringify(exit)).toContain("declares no event kinds");
  });

  it("drops the stored entry of a removed kind on the next write", () => {
    // The stored level still holds an entry of a kind the plugin removed. The
    // user's next write is the whole level, as the settings screen sends it
    // back: the entries it read, which no longer include the removed kind.
    const read = applyIntakeOverrides(
      defaults,
      { eventKinds: { "pr.removed": true, "pr.labeled": true }, signalKinds: {} },
      "plugin",
    );
    expect(read.eventKinds.map(({ kind }) => kind)).not.toContain("pr.removed");
    const written = Effect.runSync(
      normalizeIntakeOverrides(
        {
          eventKinds: Object.fromEntries(
            read.eventKinds.filter(({ level }) => level === "plugin").map((s) => [s.kind, s.on]),
          ),
          signalKinds: {},
        },
        defaults,
      ),
    );
    expect(written).toEqual({ eventKinds: { "pr.labeled": true }, signalKinds: {} });
  });
});
