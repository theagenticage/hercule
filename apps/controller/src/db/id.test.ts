import { describe, expect, it } from "vitest";
import { mintUuid, uuidFromString, uuidHexToString, uuidToString } from "./id";

const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Hercule ids", () => {
  it("mints sixteen bytes", () => {
    expect(mintUuid()).toHaveLength(16);
  });

  it("renders the canonical lowercase string form", () => {
    expect(uuidToString(mintUuid())).toMatch(CANONICAL);
  });

  it("renders every byte value", () => {
    const bytes = new Uint8Array([
      0x01, 0x92, 0xce, 0x07, 0x8c, 0x4f, 0x7d, 0x66, 0xaf, 0xec, 0x24, 0x82, 0xb5, 0xc9, 0xb0,
      0x3c,
    ]);
    expect(uuidToString(bytes)).toBe("0192ce07-8c4f-7d66-afec-2482b5c9b03c");
  });

  it("sorts by creation time", () => {
    expect(uuidToString(mintUuid()) < uuidToString(mintUuid())).toBe(true);
  });

  it("throws when the input is not sixteen bytes", () => {
    expect(() => uuidToString(new Uint8Array(15))).toThrow(TypeError);
  });

  it("renders the hex SQLite gives for an id as the same string as its bytes", () => {
    const bytes = mintUuid();
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(
      "",
    );
    expect(uuidHexToString(hex)).toBe(uuidToString(bytes));
  });

  it("throws when the hex is not 32 digits", () => {
    expect(() => uuidHexToString("0192CE07")).toThrow(TypeError);
  });

  it("round-trips a minted id through the string form", () => {
    const bytes = mintUuid();
    expect(uuidFromString(uuidToString(bytes))).toEqual(bytes);
  });

  it.each([
    ["uppercase", "0192CE07-8C4F-7D66-AFEC-2482B5C9B03C"],
    ["too short", "0192ce07-8c4f-7d66-afec-2482b5c9b03"],
    ["too long", "0192ce07-8c4f-7d66-afec-2482b5c9b03cc"],
    ["not hex", "0192ce07-8c4f-7d66-afec-2482b5c9b03z"],
    // An older, looser cursor check let this string through. It then reached
    // `uuidFromString` and threw, where a validation error was expected.
    ["thirty-six dashes", "-".repeat(36)],
    ["hex with the dashes moved", "0192ce078-c4f-7d66-afec-2482b5c9b03c"],
    ["not version 7", "0192ce07-8c4f-4d66-afec-2482b5c9b03c"],
    ["not an RFC variant", "0192ce07-8c4f-7d66-1fec-2482b5c9b03c"],
    ["empty", ""],
  ])("throws on an id that is %s", (_case, id) => {
    expect(() => uuidFromString(id)).toThrow(TypeError);
  });
});
