import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";

/**
 * How many rotated files are kept beside the live one: `<file>.1` is the most
 * recent and `<file>.5` the oldest. A rotation deletes the oldest by renaming
 * the next one over it.
 */
const KEPT_ROTATED_FILES = 5;

/** A log file that rotates itself when it grows past its size limit. */
export interface RotatingFile {
  /**
   * Appends `text` to the file. When `text` would push a non-empty file past
   * the size limit, rotates first, so `text` starts the new file. Throws the
   * filesystem error when the write or the rotation fails.
   */
  readonly append: (text: string) => void;
  /** Closes the file. */
  readonly close: () => void;
}

/**
 * Opens `path` for appending, creating it with mode 0600 when it is missing,
 * and returns a writer that rotates it at `maxBytes`. Throws the filesystem
 * error when the file cannot be opened.
 *
 * A rotation renames `<path>.4` to `<path>.5`, and so on down to `<path>` to
 * `<path>.1`, then opens a new, empty `<path>`. Writes are synchronous: a
 * process writes few log lines, and a synchronous write keeps the lines in
 * the order they were logged without a queue.
 *
 * The directory must already exist. An existing file is set to mode 0600 too,
 * because it may have been created by something else first: the edge
 * installer's LaunchAgent had launchd create `controller.log` with the default
 * mode.
 */
export function openRotatingFile(path: string, maxBytes: number): RotatingFile {
  let descriptor = openForAppend(path);
  let size = fstatSync(descriptor).size;

  return {
    append: (text) => {
      const bytes = Buffer.from(text);
      if (size > 0 && size + bytes.length > maxBytes) {
        closeSync(descriptor);
        shiftRotatedFiles(path);
        descriptor = openForAppend(path);
        size = 0;
      }
      writeSync(descriptor, bytes);
      size += bytes.length;
    },
    close: () => closeSync(descriptor),
  };
}

/** Opens `path` for appending and makes it readable and writable by its owner only. */
function openForAppend(path: string): number {
  const descriptor = openSync(path, "a", 0o600);
  fchmodSync(descriptor, 0o600);
  return descriptor;
}

/**
 * Renames each rotated file one number up, from `<path>.4` over `<path>.5`
 * down to `<path>.1`, then renames `path` to `<path>.1`.
 */
function shiftRotatedFiles(path: string): void {
  for (let number = KEPT_ROTATED_FILES - 1; number >= 1; number--) {
    const from = `${path}.${String(number)}`;
    if (existsSync(from)) renameSync(from, `${path}.${String(number + 1)}`);
  }
  renameSync(path, `${path}.1`);
}
