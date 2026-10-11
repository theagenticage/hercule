/**
 * Tests the pure rules of Intake settings:
 *
 * - a plugin's choice and a Connection's choice are layered on the plugin's
 *   defaults, the Connection's winning;
 * - a write drops the entries that equal the level below, and refuses a kind
 *   the plugin does not declare;
 * - an entry for a kind the plugin no longer declares is ignored on read.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { IntakeOverrides, IntakeSettings } from "@hercule/contract";
import {
  applyIntakeOverrides,
  createPluginNotLoadedError,
  normalizeIntakeOverrides,
  NO_INTAKE_OVERRIDES,
} from "./settings";

/** What a plugin gives before the user chooses anything. */
const defaults: IntakeSettings = {
  eventKinds: [
    { kind: "pr.opened", description: "A pull request was opened.", on: true, level: "default" },
    { kind: "pr.labeled", description: "A label was added.", on: false, level: "default" },
  ],
  signalKinds: [
    {
      kind: "github/team-review-requested",
      label: "Team review requested",
      description: "A review was requested from your team.",
      on: true,
      level: "default",
    },
    {
      kind: "github/review-requested",
      label: "Review requested",
      description: "A review was requested from you.",
      on: true,
      level: "default",
    },
  ],
};

const noKinds: IntakeSettings = { eventKinds: [], signalKinds: [] };

const onOf = (
  settings: ReadonlyArray<{ readonly kind: string; readonly on: boolean; readonly level: string }>,
) => Object.fromEntries(settings.map(({ kind, on, level }) => [kind, `${on}@${level}`]));

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

  it("keeps the declared order and the texts", () => {
    const plugin = applyIntakeOverrides(
      defaults,
      { eventKinds: { "pr.labeled": true }, signalKinds: {} },
      "plugin",
    );
    expect(plugin.eventKinds.map(({ kind }) => kind)).toEqual(["pr.opened", "pr.labeled"]);
    expect(plugin.signalKinds[0]).toMatchObject({
      label: "Team review requested",
      description: "A review was requested from your team.",
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
      {
        eventKinds: [{ kind: "toString", description: "", on: true, level: "default" }],
        signalKinds: [],
      },
      NO_INTAKE_OVERRIDES,
      "plugin",
    );
    expect(applied.eventKinds[0]).toMatchObject({ on: true, level: "default" });
  });
});

describe("normalizeIntakeOverrides", () => {
  const normalize = (written: IntakeOverrides, below = defaults) =>
    Effect.runSyncExit(normalizeIntakeOverrides(written, below));

  /** Returns the validation error of a failed exit, or fails the test. */
  const readValidationError = (exit: ReturnType<typeof normalize>) => {
    if (!Exit.isFailure(exit)) throw new Error("expected the write to be refused");
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
    if (failure === undefined) throw new Error("expected a typed failure");
    return failure.error;
  };

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

  it("refuses a kind the plugin does not declare, with one short issue and path per kind", () => {
    const { error } = readValidationError(
      normalize({
        eventKinds: { "pr.unknown": true },
        signalKinds: { "github/unknown": false },
      }),
    );
    expect(error.details.issues).toEqual([
      {
        path: ["intake", "eventKinds", "pr.unknown"],
        message: "pr.unknown is not an event kind of this plugin.",
      },
      {
        path: ["intake", "signalKinds", "github/unknown"],
        message: "github/unknown is not a signal kind of this plugin.",
      },
    ]);
  });

  it("lists the kinds to choose from once, in the top-level message", () => {
    const { error } = readValidationError(
      normalize({
        eventKinds: { "pr.unknown": true, "pr.other": true },
        signalKinds: { "github/unknown": false },
      }),
    );
    expect(error.message).toBe(
      "The plugin does not declare pr.unknown, pr.other, github/unknown. " +
        "Choose event kinds from pr.opened, pr.labeled. " +
        "Choose signal kinds from github/team-review-requested, github/review-requested.",
    );
  });

  it("lists only the choices of the switch that was refused", () => {
    const { error } = readValidationError(
      normalize({ eventKinds: { "pr.unknown": true }, signalKinds: {} }),
    );
    expect(error.message).toBe(
      "The plugin does not declare pr.unknown. Choose event kinds from pr.opened, pr.labeled.",
    );
  });

  it("says there is nothing to choose for a plugin that declares no kinds", () => {
    const { error } = readValidationError(
      normalize({ eventKinds: { "pr.opened": true }, signalKinds: {} }, noKinds),
    );
    expect(error.message).toContain("declares no event kinds");
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

describe("createPluginNotLoadedError", () => {
  it("names the plugin, says it failed to load and says what to do", () => {
    const { error } = createPluginNotLoadedError("github");
    expect(error.code).toBe("validation");
    expect(error.message).toContain("github failed to load");
    expect(error.message).toContain("restart the controller");
  });
});
