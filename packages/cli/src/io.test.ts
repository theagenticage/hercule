/**
 * Tests how the CLI decodes stdin. Invalid UTF-8 fails with a usage error and
 * is never replaced, because the replaced text would then be sent as if the
 * caller had written it.
 */
import { describe, expect, it } from "vitest";
import { UsageError } from "./exit";
import { decodeStdin } from "./io";

describe("decodeStdin", () => {
  it("decodes UTF-8 and keeps a leading byte order mark", () => {
    const bom = [0xef, 0xbb, 0xbf];
    const cafe = [0x63, 0x61, 0x66, 0xc3, 0xa9];
    const text = decodeStdin(Uint8Array.from([...bom, ...cafe, 0x0a]));
    expect(text.codePointAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe("café\n");
  });

  it("fails with a usage error on bytes that are not valid UTF-8", () => {
    // 0xff never appears in UTF-8. 0xc3 starts a two-byte character that the input does not finish.
    for (const bytes of [
      [0x61, 0xff, 0x0a],
      [0x61, 0xc3],
    ]) {
      const decode = () => decodeStdin(Uint8Array.from(bytes));
      expect(decode).toThrow(UsageError);
      expect(decode).toThrow(/not valid UTF-8/);
    }
  });
});
