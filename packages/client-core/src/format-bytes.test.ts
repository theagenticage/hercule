import { describe, expect, it } from "vitest";
import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it("uses the largest unit that keeps the number at one or more", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4096)).toBe("4 KiB");
    expect(formatBytes(64 * 1024 ** 2)).toBe("64 MiB");
    expect(formatBytes(64 * 1024 ** 3)).toBe("64 GiB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3 TiB");
  });

  it("shows one decimal only below ten", () => {
    expect(formatBytes(1.2 * 1024 ** 3)).toBe("1.2 GiB");
    expect(formatBytes(9.94 * 1024 ** 3)).toBe("9.9 GiB");
    expect(formatBytes(10.4 * 1024 ** 3)).toBe("10 GiB");
  });

  // A value just under the next unit rounds up into that unit: `1024 MiB` is
  // a gibibyte written the wrong way.
  it("moves to the next unit rather than showing 1024", () => {
    expect(formatBytes(1024 ** 3 - 1)).toBe("1 GiB");
    expect(formatBytes(1024 ** 2 - 1)).toBe("1 MiB");
    expect(formatBytes(1023.6 * 1024 ** 3)).toBe("1 TiB");
  });

  // A runner with no space left shows 0 B rather than an empty string.
  it("formats zero as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
  });
});
