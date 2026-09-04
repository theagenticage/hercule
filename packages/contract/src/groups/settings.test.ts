import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { SettingsPatch, SettingsState } from "./settings";

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
