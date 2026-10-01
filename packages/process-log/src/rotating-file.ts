import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * How many rotated files are kept beside the live one: `<file>.1` is the most
 * recent and `<file>.5` the oldest. A rotation deletes the oldest by renaming
 * the next one over it.
 */
const KEPT_ROTATED_FILES = 5;

/**
 * The old log files could not be renamed, so the log file was not rotated and
 * grows past its size limit until a rotation succeeds.
 */
export class LogRotationError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `cannot rotate ${path}, so it grows past its size limit until a rotation succeeds: ${String(cause)}. Check that this user can write to ${dirname(path)} and the files in it.`,
      { cause },
    );
    this.name = "LogRotationError";
  }
}

/** A log file that rotates itself when it grows past its size limit. */
export interface RotatingFile {
  /**
   * Appends `text` to the file. When `text` would push a non-empty file past
   * the size limit, rotates first, so `text` starts the new file. Throws the
   * filesystem error when the write fails.
   *
   * When only the rotation fails, still appends `text`, so a log that cannot
   * rotate keeps its lines. Every later call over the limit tries to rotate
   * again. Only the first failure in a row throws a `LogRotationError`, after
   * the write, so a rotation that keeps failing is reported once rather than
   * with every line.
   */
  readonly append: (text: string) => void;
  /** Closes the file. */
  readonly close: () => void;
}

/**
 * Opens `path` for appending, creating it with mode 0600 and its folder with
 * mode 0700 when they are missing, and returns a writer that rotates it at
 * `maxBytes`. Throws the filesystem error when the file cannot be opened.
 *
 * A rotation renames `<path>.4` to `<path>.5`, and so on down to `<path>` to
 * `<path>.1`, then opens a new, empty `<path>`. Writes are synchronous: a
 * process writes few log lines, and a synchronous write keeps the lines in
 * the order they were logged without a queue.
 *
 * The file and its folder are created again whenever they are found missing,
 * so a log that someone deleted while the process runs comes back with the
 * next rotation. An existing file is set to mode 0600 too, because it may
 * have been created by something else first: an older edge installer had
 * launchd create `controller.log` with the default mode.
 */
export function openRotatingFile(path: string, maxBytes: number): RotatingFile {
  // `undefined` while no file is open. A descriptor is never kept after it is
  // closed: the OS hands its number to the next file this process opens, and
  // closing that number again would close a database or a socket.
  let descriptor: number | undefined;
  let size = 0;
  let rotationFailing = false;
  const openLogFile = (): number => {
    const opened = openForAppend(path);
    descriptor = opened;
    size = fstatSync(opened).size;
    return opened;
  };
  const writeAndCount = (to: number, bytes: Buffer): void => {
    writeSync(to, bytes);
    size += bytes.length;
  };
  openLogFile();

  return {
    append: (text) => {
      const bytes = Buffer.from(text);
      const current = descriptor ?? openLogFile();
      if (size === 0 || size + bytes.length <= maxBytes) {
        writeAndCount(current, bytes);
        return;
      }
      closeSync(current);
      descriptor = undefined;
      let failure: LogRotationError | undefined;
      try {
        shiftRotatedFiles(path);
        rotationFailing = false;
      } catch (cause) {
        if (!rotationFailing) failure = new LogRotationError(path, cause);
        rotationFailing = true;
      }
      writeAndCount(openLogFile(), bytes);
      if (failure !== undefined) throw failure;
    },
    close: () => {
      if (descriptor !== undefined) closeSync(descriptor);
      descriptor = undefined;
    },
  };
}

/**
 * Opens `path` for appending and makes it readable and writable by its owner
 * only, creating its folder first when it is missing.
 */
function openForAppend(path: string): number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, "a", 0o600);
  fchmodSync(descriptor, 0o600);
  return descriptor;
}

/**
 * Renames each rotated file one number up, from `<path>.4` over `<path>.5`
 * down to `<path>.1`, then renames `path` to `<path>.1`. Skips a file that is
 * missing, because someone may have deleted it.
 */
function shiftRotatedFiles(path: string): void {
  for (let number = KEPT_ROTATED_FILES - 1; number >= 1; number--) {
    const from = `${path}.${String(number)}`;
    if (existsSync(from)) renameSync(from, `${path}.${String(number + 1)}`);
  }
  if (existsSync(path)) renameSync(path, `${path}.1`);
}
