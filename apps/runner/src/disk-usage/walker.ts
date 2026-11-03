/**
 * Adds up the disk space a folder takes, counting allocated blocks the way
 * `du` does. It reads nothing but file metadata and imports only Node
 * built-ins, because the compiled binary runs it as the `measure-disk-usage`
 * verb in a child process (see `measure-main.ts`).
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The size of the unit `Stats.blocks` counts in, on every platform Node reports it for. */
const BLOCK_BYTES = 512n;

export interface FolderUsage {
  /** The bytes every file below the folder takes, each file counted once however many links it has. */
  readonly sizeBytes: number;
  /** The part of `sizeBytes` that deleting the folder gives back: directories and files with one link. */
  readonly freesBytes: number;
}

/** Returns the message of a failed file system call, with the path it failed on. */
const describeFailure = (path: string, error: unknown): Error => {
  const code = (error as NodeJS.ErrnoException).code;
  return new Error(
    `Cannot read ${path}${code === undefined ? "" : ` (${code})`}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
};

/**
 * Walks `root` and returns the space it takes.
 *
 * - Space is `blocks * 512` from `lstat`, not the file length, so sparse and
 *   compressed files count what they really take.
 * - A symbolic link counts for its own blocks and is never followed.
 * - A directory on another device than `root` is skipped, mount point
 *   included.
 * - A file with more than one link is counted once in `sizeBytes` (by device
 *   and inode) and never in `freesBytes`, because deleting this folder does
 *   not give its blocks back while another path still links to them.
 * - Directories count in both numbers.
 *
 * A file or directory that disappears during the walk is skipped. Fails when
 * `root` does not exist or anything else cannot be read, because a total that
 * silently left a folder out would be wrong.
 */
export const walkFolder = (root: string): FolderUsage => {
  let rootStats;
  try {
    rootStats = lstatSync(root, { bigint: true });
  } catch (error) {
    throw describeFailure(root, error);
  }
  let size = 0n;
  let frees = 0n;
  // Only files with several links can show up twice, so only they are kept.
  const linkedInodes = new Set<string>();
  const pending: string[] = [];
  size += rootStats.blocks * BLOCK_BYTES;
  frees += rootStats.blocks * BLOCK_BYTES;
  if (rootStats.isDirectory()) pending.push(root);

  while (pending.length > 0) {
    const directory = pending.pop()!;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw describeFailure(directory, error);
    }
    for (const name of names) {
      const path = join(directory, name);
      let stats;
      try {
        stats = lstatSync(path, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw describeFailure(path, error);
      }
      if (stats.dev !== rootStats.dev) continue;
      const bytes = stats.blocks * BLOCK_BYTES;
      if (stats.isDirectory()) {
        size += bytes;
        frees += bytes;
        pending.push(path);
      } else if (stats.nlink > 1n) {
        const key = `${stats.dev}:${stats.ino}`;
        if (linkedInodes.has(key)) continue;
        linkedInodes.add(key);
        size += bytes;
      } else {
        size += bytes;
        frees += bytes;
      }
    }
  }
  return { sizeBytes: Number(size), freesBytes: Number(frees) };
};
