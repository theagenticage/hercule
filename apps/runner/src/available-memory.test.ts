/**
 * Tests the available memory a runner reports. The parsers are checked on
 * samples of what `vm_stat` and `/proc/meminfo` print:
 *
 * - macOS is the total memory minus Activity Monitor's "Memory Used" (app
 *   memory + wired + compressed), with the page size taken from the first
 *   line, which differs between Apple silicon (16384) and Intel (4096);
 * - Linux reads `MemAvailable`;
 * - a malformed read fails, instead of turning into a number that looks right.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { totalmem } from "node:os";
import {
  parseMemInfoAvailableBytes,
  parseVmStatAvailableBytes,
  readAvailableMemoryBytes,
} from "./available-memory";

/** The output of `vm_stat` on an Apple silicon Mac that has run for a while. */
const VM_STAT_16K = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              974586.
Pages active:                           1321820.
Pages inactive:                         1296744.
Pages speculative:                        28406.
Pages throttled:                              0.
Pages wired down:                        289744.
Pages purgeable:                         161744.
"Translation faults":               53950477786.
Pages copy-on-write:                 4385562765.
Pages zero filled:                  29064310588.
Pages reactivated:                    505645181.
Pages purged:                         300927856.
File-backed pages:                       872919.
Anonymous pages:                        1774051.
Pages stored in compressor:             1509514.
Pages occupied by compressor:            222707.
Decompressions:                       300808919.
Compressions:                         425963332.
Pageins:                              663605358.
Pageouts:                               1068393.
Swapins:                                1651065.
Swapouts:                               2876800.
`;

const VM_STAT_4K = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                               1000.
Pages active:                            50000.
Pages inactive:                           2000.
Pages speculative:                         300.
Pages wired down:                        40000.
Pages purgeable:                           700.
Anonymous pages:                         30700.
Pages occupied by compressor:             5000.
`;

const GIB = 1024 ** 3;

const MEM_INFO = `MemTotal:       16314484 kB
MemFree:          812340 kB
MemAvailable:    9876544 kB
Buffers:          412000 kB
Cached:          7000000 kB
SwapTotal:       2097148 kB
`;

describe("parseVmStatAvailableBytes", () => {
  it("returns the total minus app memory, wired and compressed pages, times the 16384-byte page size", () => {
    // App memory is the anonymous pages minus the purgeable ones.
    const usedPages = 1_774_051 - 161_744 + 289_744 + 222_707;
    expect(parseVmStatAvailableBytes(VM_STAT_16K, 64 * GIB)).toBe(64 * GIB - usedPages * 16_384);
  });

  it("uses the page size from the first line, not an assumed 4096", () => {
    // 30000 app pages + 40000 wired + 5000 compressed.
    expect(parseVmStatAvailableBytes(VM_STAT_4K, GIB)).toBe(GIB - 75_000 * 4096);
  });

  it("does not count free, inactive and speculative pages as used", () => {
    const busier = VM_STAT_4K.replace("1000.", "9999.")
      .replace("2000.", "8888.")
      .replace("300.", "77.");
    expect(parseVmStatAvailableBytes(busier, GIB)).toBe(parseVmStatAvailableBytes(VM_STAT_4K, GIB));
  });

  it("returns zero when the pages in use outgrow the total memory", () => {
    expect(parseVmStatAvailableBytes(VM_STAT_4K, 75_000 * 4096 - 1)).toBe(0);
    expect(parseVmStatAvailableBytes(VM_STAT_4K, 1000)).toBe(0);
  });

  it("fails when the page size is missing", () => {
    expect(() => parseVmStatAvailableBytes(VM_STAT_4K.replace(/^.*\n/, ""), GIB)).toThrow(
      /page size/,
    );
  });

  it.each([
    "Anonymous pages",
    "Pages purgeable",
    "Pages wired down",
    "Pages occupied by compressor",
  ])("fails when the %s counter is missing", (name) => {
    const without = VM_STAT_4K.replace(new RegExp(`^${name}.*\\n`, "m"), "");
    expect(() => parseVmStatAvailableBytes(without, GIB)).toThrow(name);
  });

  it("fails when a counter is not a number", () => {
    expect(() => parseVmStatAvailableBytes(VM_STAT_4K.replace("30700.", "many."), GIB)).toThrow(
      /Anonymous pages/,
    );
  });

  it("fails on text that is not vm_stat output", () => {
    expect(() => parseVmStatAvailableBytes("", GIB)).toThrow();
    expect(() => parseVmStatAvailableBytes("command not found: vm_stat", GIB)).toThrow();
  });
});

describe("parseMemInfoAvailableBytes", () => {
  it("returns MemAvailable in bytes", () => {
    expect(parseMemInfoAvailableBytes(MEM_INFO)).toBe(9_876_544 * 1024);
  });

  it("fails on a kernel that has no MemAvailable line", () => {
    expect(() => parseMemInfoAvailableBytes("MemTotal: 1000 kB\nMemFree: 500 kB\n")).toThrow(
      /MemAvailable/,
    );
  });

  it("fails when MemAvailable is not a number of kilobytes", () => {
    expect(() => parseMemInfoAvailableBytes("MemAvailable: lots kB\n")).toThrow(/MemAvailable/);
  });
});

describe("readAvailableMemoryBytes on the real machine", () => {
  it("returns a positive whole number of bytes that fits in the machine's memory", async () => {
    const bytes = await Effect.runPromise(readAvailableMemoryBytes);

    expect(Number.isInteger(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(totalmem());
  });
});
