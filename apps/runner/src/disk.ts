/**
 * Reads the size and the free space of a disk, for the Runner Facts
 * (`diskTotalBytes`) and the Runner Metrics (`diskFreeBytes`). Both are read
 * from the same file system, the one that holds the runner's storage
 * directory, so the free space is always a share of the total.
 */
import { statfs } from "node:fs/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export interface DiskSpace {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

/**
 * Returns the size and the free space of the file system that holds `path`.
 * Fails when `path` cannot be read.
 *
 * `bsize` is the right multiplier for every block count here. On Linux and
 * macOS, `statfs` reports `blocks`, `bfree` and `bavail` in units of `bsize`
 * (the file system's block size), which is not true of `statvfs`, where
 * the unit is `frsize`.
 */
export const readDiskSpace = (path: string): Effect.Effect<DiskSpace, Cause.UnknownError> =>
  Effect.map(
    Effect.tryPromise(() => statfs(path)),
    (stats) => ({
      totalBytes: stats.blocks * stats.bsize,
      // `bavail` counts the blocks an unprivileged user may still write, and
      // sessions run as an unprivileged user.
      freeBytes: stats.bavail * stats.bsize,
    }),
  );
