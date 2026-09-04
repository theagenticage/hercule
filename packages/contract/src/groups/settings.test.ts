import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { MAX_SETTING_LIST, SettingsPatch, SettingsState } from "./settings";

const decode =
  <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  (input: unknown) =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input));

describe("the thread row density setting", () => {
  it("takes each density a write may name", () => {
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

  it("reads back out of the settings state, and encodes back in", () => {
    const state = { controller: {}, user: { "ui.threadRows": "plain" } };
    expect(decode(SettingsState)(state)).toMatchObject({ _tag: "Success", value: state });
    expect(Effect.runSyncExit(Schema.encodeUnknownEffect(SettingsState)(state))).toMatchObject({
      _tag: "Success",
      value: state,
    });
  });
});

describe("the bounds on a user setting that holds a list", () => {
  const steps = (count: number) =>
    Array.from({ length: count }, (_, index) => `step-${String(index)}`);

  it("takes a list at the cap and refuses the one past it", () => {
    for (const key of ["topics.order", "onboarding.completedSteps"]) {
      expect(decode(SettingsPatch)({ user: { [key]: steps(MAX_SETTING_LIST) } })._tag).toBe(
        "Success",
      );
      expect(decode(SettingsPatch)({ user: { [key]: steps(MAX_SETTING_LIST + 1) } })._tag).toBe(
        "Failure",
      );
    }
  });

  it("bounds the mute list too", () => {
    const muted = (count: number) =>
      Array.from({ length: count }, (_, index) => `workflow:w${String(index)}`);
    expect(decode(SettingsPatch)({ user: { "notifications.muted": muted(1) } })._tag).toBe(
      "Success",
    );
    expect(
      decode(SettingsPatch)({ user: { "notifications.muted": muted(MAX_SETTING_LIST + 1) } })._tag,
    ).toBe("Failure");
  });
});
