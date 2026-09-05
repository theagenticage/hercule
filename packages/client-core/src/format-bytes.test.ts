import { describe, expect, it } from "vitest";
import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it("climbs to the largest unit that leaves a figure a person can hold", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4096)).toBe("4 KiB");
    expect(formatBytes(64 * 1024 ** 2)).toBe("64 MiB");
    expect(formatBytes(64 * 1024 ** 3)).toBe("64 GiB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3 TiB");
  });

  it("keeps one decimal only while the figure is small enough to need it", () => {
    expect(formatBytes(1.2 * 1024 ** 3)).toBe("1.2 GiB");
    expect(formatBytes(9.94 * 1024 ** 3)).toBe("9.9 GiB");
    expect(formatBytes(10.4 * 1024 ** 3)).toBe("10 GiB");
  });

  // A reading a hair under the next unit rounds into it rather than being
  // written in a unit nobody uses: `1024 MiB` is a gibibyte spelled wrong.
  it("climbs a unit rather than printing a figure of 1024", () => {
    expect(formatBytes(1024 ** 3 - 1)).toBe("1 GiB");
    expect(formatBytes(1024 ** 2 - 1)).toBe("1 MiB");
    expect(formatBytes(1023.6 * 1024 ** 3)).toBe("1 TiB");
  });

  // A machine with nothing left says so, rather than saying nothing.
  it("reads zero as zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });
});
