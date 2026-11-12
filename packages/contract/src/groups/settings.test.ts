import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { MAX_SETTING_LIST, SettingsPatch, SettingsState } from "./settings";

const decode =
  <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  (input: unknown) =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input));

describe("the thread row density setting", () => {
  it("accepts each valid density", () => {
    for (const density of ["meta", "plain"]) {
      expect(decode(SettingsPatch)({ user: { "ui.threadRows": density } })).toMatchObject({
        _tag: "Success",
        value: { user: { "ui.threadRows": density } },
      });
    }
  });

  it("rejects a density that is not one of the two", () => {
    expect(decode(SettingsPatch)({ user: { "ui.threadRows": "rich" } })._tag).toBe("Failure");
  });

  it("decodes from the settings state, and encodes back", () => {
    const state = { controller: {}, user: { "ui.threadRows": "plain" } };
    expect(decode(SettingsState)(state)).toMatchObject({ _tag: "Success", value: state });
    expect(Effect.runSyncExit(Schema.encodeUnknownEffect(SettingsState)(state))).toMatchObject({
      _tag: "Success",
      value: state,
    });
  });
});

describe("the bounds on a user setting that holds a list", () => {
  const buildSteps = (count: number) =>
    Array.from({ length: count }, (_, index) => `step-${String(index)}`);

  it("accepts a list at the cap, and rejects a list one longer", () => {
    expect(
      decode(SettingsPatch)({ user: { "onboarding.completedSteps": buildSteps(MAX_SETTING_LIST) } })
        ._tag,
    ).toBe("Success");
    expect(
      decode(SettingsPatch)({
        user: { "onboarding.completedSteps": buildSteps(MAX_SETTING_LIST + 1) },
      })._tag,
    ).toBe("Failure");
  });

  it("bounds the mute list too", () => {
    const buildMutedList = (count: number) =>
      Array.from({ length: count }, (_, index) => `workflow:w${String(index)}`);
    expect(decode(SettingsPatch)({ user: { "notifications.muted": buildMutedList(1) } })._tag).toBe(
      "Success",
    );
    expect(
      decode(SettingsPatch)({
        user: { "notifications.muted": buildMutedList(MAX_SETTING_LIST + 1) },
      })._tag,
    ).toBe("Failure");
  });
});

describe("the Inbox rail settings", () => {
  const pin = { source: "linear", key: "team", value: "Checkout" };

  it("accepts pins and folded sources, with or without an account", () => {
    const connectionId = "01963f0a-0000-7000-8000-000000000001";
    expect(
      decode(SettingsPatch)({
        user: {
          "inbox.pins": [pin, { ...pin, connectionId }],
          "inbox.browseFolded": [{ source: "linear" }, { source: "linear", connectionId }],
        },
      })._tag,
    ).toBe("Success");
  });

  it("rejects a list of 51 pins, and a pin without a value", () => {
    const pins = Array.from({ length: 51 }, () => pin);
    expect(decode(SettingsPatch)({ user: { "inbox.pins": pins } })._tag).toBe("Failure");
    expect(
      decode(SettingsPatch)({ user: { "inbox.pins": [{ source: "linear", key: "team" }] } })._tag,
    ).toBe("Failure");
    expect(
      decode(SettingsPatch)({
        user: { "inbox.browseFolded": Array.from({ length: 51 }, () => ({ source: "linear" })) },
      })._tag,
    ).toBe("Failure");
  });
});
