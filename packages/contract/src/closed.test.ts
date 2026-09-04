import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { closedStruct } from "./closed";
import { SettingsPatch } from "./groups/settings";

const decode =
  <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  (input: unknown) =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input));

describe("a closed struct", () => {
  const Example = closedStruct({ a: Schema.optionalKey(Schema.String) });

  it("decodes what it declares", () => {
    expect(decode(Example)({ a: "x" })).toMatchObject({ _tag: "Success", value: { a: "x" } });
    expect(decode(Example)({})).toMatchObject({ _tag: "Success", value: {} });
  });

  it("fails on a key it does not declare, rather than stripping it", () => {
    expect(decode(Example)({ a: "x", b: 1 })._tag).toBe("Failure");
  });

  it("encodes a value back out", () => {
    expect(Effect.runSyncExit(Schema.encodeUnknownEffect(Example)({ a: "x" }))).toMatchObject({
      _tag: "Success",
      value: { a: "x" },
    });
  });
});

describe("settings.update's payload", () => {
  it("takes a partial write in either scope", () => {
    expect(decode(SettingsPatch)({ user: { timezone: "Europe/Amsterdam" } })).toMatchObject({
      _tag: "Success",
      value: { user: { timezone: "Europe/Amsterdam" } },
    });
  });

  it("rejects an unknown key in a scope", () => {
    expect(decode(SettingsPatch)({ user: { timezone: "UTC", nope: 1 } })._tag).toBe("Failure");
  });

  it("rejects an unknown scope", () => {
    expect(decode(SettingsPatch)({ nope: {} })._tag).toBe("Failure");
  });

  it("rejects a declared key whose value is wrong", () => {
    expect(decode(SettingsPatch)({ controller: { "backup.time": "25:00" } })._tag).toBe("Failure");
  });
});
