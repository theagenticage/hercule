/**
 * What the CLI makes of the bytes on stdin: the UTF-8 text they spell, or a
 * usage error. A byte that is not UTF-8 is never replaced, because the
 * replaced text would then be sent as if the caller had written it.
 */
import { describe, expect, it } from "vitest";
import { UsageError } from "./exit";
import { decodeStdin } from "./io";

describe("the text read from stdin", () => {
  it("is the text the UTF-8 bytes spell, with a leading byte order mark kept", () => {
    const bom = [0xef, 0xbb, 0xbf];
    const cafe = [0x63, 0x61, 0x66, 0xc3, 0xa9];
    const text = decodeStdin(Uint8Array.from([...bom, ...cafe, 0x0a]));
    expect(text.codePointAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe("café\n");
  });

  it("refuses bytes that are not UTF-8 with a usage error that says so", () => {
    // 0xff is never a byte of UTF-8, and 0xc3 alone starts a character it does not finish.
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
