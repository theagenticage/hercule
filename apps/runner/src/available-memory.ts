/**
 * Reads the memory the operating system can give a new process without
 * swapping, for the Runner Metrics.
 *
 * `os.freemem()` is not that number. On macOS it counts only the pages nobody
 * uses, which is close to zero on a Mac that has run for a while, because the
 * system keeps spare memory as file cache. So each platform is read its own way:
 *
 * - Linux: `MemAvailable` from `/proc/meminfo`.
 * - macOS: the total memory minus what Activity Monitor calls "Memory Used",
 *   computed from one run of `vm_stat`.
 * - Other platforms (Windows): `os.freemem()`, which does count cache there.
 *
 * A read that cannot be made or understood fails. It never falls back to
 * `os.freemem()` on macOS or Linux: that is the wrong number there, and a wrong
 * number that looks right is worse than a skipped report.
 */
import { readFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

const VM_STAT_PAGE_SIZE = /page size of (\d+) bytes/;

/**
 * Reads one page counter from `vm_stat` text. A counter line is
 * `<name>:   <count>.`, and the count ends in a period. Throws when the line is
 * missing or the count is not a number.
 */
const readVmStatPages = (text: string, name: string): number => {
  const count = new RegExp(`^${name}:\\s+(\\d+)\\.\\s*$`, "m").exec(text)?.[1];
  if (count === undefined) throw new Error(`vm_stat printed no "${name}" count`);
  return Number(count);
};

/**
 * Parses the text `vm_stat` prints on macOS and returns the available memory
 * in bytes: the total memory minus Activity Monitor's "Memory Used", never below
 * zero. Throws when the page size or one of the counters is missing or is not a
 * number.
 *
 * Memory Used is App Memory + Wired + Compressed:
 *
 * - App Memory is the anonymous pages (memory no file backs) minus the
 *   purgeable ones, which an app has marked as droppable.
 * - Wired is the pages the kernel cannot move or drop.
 * - Compressed is the pages the compressor occupies.
 *
 * The result then equals the figure the user sees in Activity Monitor. The
 * obvious alternative, adding the free, inactive and purgeable pages, reads 6 to
 * 7 GiB too high on a 64 GiB Mac. The inactive pages include anonymous memory
 * that must be compressed or swapped out before anything else can use it.
 *
 * The page size comes from the first line, because it is 16384 bytes on Apple
 * silicon and 4096 on Intel. The total memory is passed in so this function
 * stays pure.
 */
export const parseVmStatAvailableBytes = (text: string, totalMemoryBytes: number): number => {
  const pageSize = Number(VM_STAT_PAGE_SIZE.exec(text)?.[1]);
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error("vm_stat printed no page size in its first line");
  }
  const appPages =
    readVmStatPages(text, "Anonymous pages") - readVmStatPages(text, "Pages purgeable");
  const wiredPages = readVmStatPages(text, "Pages wired down");
  const compressedPages = readVmStatPages(text, "Pages occupied by compressor");
  const usedBytes = (appPages + wiredPages + compressedPages) * pageSize;
  return Math.max(0, totalMemoryBytes - usedBytes);
};

/**
 * Parses the text of `/proc/meminfo` and returns `MemAvailable` in bytes.
 * Throws when the line is missing or is not a number of kilobytes.
 */
export const parseMemInfoAvailableBytes = (text: string): number => {
  const kilobytes = /^MemAvailable:\s+(\d+) kB\s*$/m.exec(text)?.[1];
  if (kilobytes === undefined) throw new Error("/proc/meminfo has no MemAvailable line");
  return Number(kilobytes) * 1024;
};

/**
 * Runs `vm_stat` once and returns what it printed. Kills the process when the
 * caller stops waiting, which is when the connection ends or the read times out.
 * It runs the binary by its full path, so no `PATH` search can find another
 * program with that name, and it works under a service manager's short `PATH`.
 */
const runVmStat = (signal: AbortSignal): Promise<string> => {
  const child = Bun.spawn(["/usr/bin/vm_stat"], { stdout: "pipe", stderr: "ignore" });
  // Otherwise a `vm_stat` that hangs would keep running after nobody waits for it.
  signal.addEventListener("abort", () => {
    child.kill();
  });
  return (async () => {
    const printed = await new Response(child.stdout).text();
    await child.exited;
    if (child.exitCode !== 0) throw new Error(`vm_stat exited with code ${child.exitCode}`);
    return printed;
  })();
};

/**
 * Returns the bytes of memory the operating system can give a new process
 * without swapping. Fails when the platform's source cannot be read or is
 * malformed; the caller logs that and skips the report.
 */
export const readAvailableMemoryBytes: Effect.Effect<number, Cause.UnknownError> = Effect.suspend(
  () => {
    switch (process.platform) {
      case "linux":
        return Effect.tryPromise(async () =>
          parseMemInfoAvailableBytes(await readFile("/proc/meminfo", "utf8")),
        );
      case "darwin":
        return Effect.tryPromise(async (signal) =>
          parseVmStatAvailableBytes(await runVmStat(signal), totalmem()),
        );
      default:
        return Effect.sync(() => freemem());
    }
  },
);
