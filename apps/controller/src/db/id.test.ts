import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { mintUuid, shortUuid, uuidFromString, uuidToString, UuidString } from "./id";

const decode = Schema.decodeUnknownSync(UuidString);

describe("Hydra ids", () => {
  it("mints sixteen bytes", () => {
    expect(mintUuid()).toHaveLength(16);
  });

  it("renders the canonical lowercase string form", () => {
    const rendered = uuidToString(mintUuid());
    expect(rendered).toBe(rendered.toLowerCase());
    expect(decode(rendered)).toBe(rendered);
  });

  it("round-trips bytes through the string form", () => {
    const bytes = mintUuid();
    expect(uuidFromString(uuidToString(bytes))).toEqual(bytes);
  });

  it("renders every byte value", () => {
    const bytes = new Uint8Array([
      0x01, 0x92, 0xce, 0x07, 0x8c, 0x4f, 0x7d, 0x66, 0xaf, 0xec, 0x24, 0x82, 0xb5, 0xc9, 0xb0,
      0x3c,
    ]);
    expect(uuidToString(bytes)).toBe("0192ce07-8c4f-7d66-afec-2482b5c9b03c");
    expect(uuidFromString("0192ce07-8c4f-7d66-afec-2482b5c9b03c")).toEqual(bytes);
  });

  it("sorts by creation time", () => {
    const first = uuidToString(mintUuid());
    const second = uuidToString(mintUuid());
    expect(first < second).toBe(true);
  });

  it("shortens to the last eight hex characters", () => {
    expect(shortUuid("0192ce07-8c4f-7d66-afec-2482b5c9b03c")).toBe("b5c9b03c");
    const bytes = mintUuid();
    expect(shortUuid(bytes)).toBe(uuidToString(bytes).slice(-8));
  });

  it("rejects an uppercase or malformed id", () => {
    expect(() => decode("0192CE07-8C4F-7D66-AFEC-2482B5C9B03C")).toThrow();
    expect(() => uuidFromString("not-an-id")).toThrow(TypeError);
  });
});
