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
    for (const key of ["topics.order", "onboarding.completedSteps"]) {
      expect(decode(SettingsPatch)({ user: { [key]: buildSteps(MAX_SETTING_LIST) } })._tag).toBe(
        "Success",
      );
      expect(
        decode(SettingsPatch)({ user: { [key]: buildSteps(MAX_SETTING_LIST + 1) } })._tag,
      ).toBe("Failure");
    }
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
