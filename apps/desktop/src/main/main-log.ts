/**
 * Main's log file: every line main logs is also written to `main.log` in the
 * logs folder inside the app's data folder. An app opened from the Dock or
 * the Finder has nowhere to show what main prints, so without the file a
 * problem left no trace once the app quit.
 *
 * The folder sits inside the app's data folder, not in the system's logs
 * folder, so a launch with its own `--user-data-dir`, as every end-to-end test
 * makes, writes its own log.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

/**
 * The size at which the log file is rotated, in bytes. Main logs only what
 * goes wrong, so 2 MiB holds months of a healthy app.
 */
const MAX_MAIN_LOG_BYTES = 2 * 1024 * 1024;

/** Returns the path of main's log file inside the app's data folder `userDataDir`. */
export const locateMainLog = (userDataDir: string): string =>
  path.join(userDataDir, "logs", "main.log");

/**
 * Returns a function that appends one line to the log file at `file`, after
 * creating its folder (mode 0700) and the file (mode 0600). The lines can
 * hold page addresses and call stacks, so only this user may read them.
 *
 * When a line would push a non-empty file past `maxBytes`, the file is first
 * renamed to `<file>.1`, which replaces the one renamed before, and the line
 * starts a new file. So the log never takes more than twice `maxBytes`.
 *
 * Throws the filesystem error when the folder cannot be created or a write
 * fails.
 */
export const openMainLog = (file: string, maxBytes: number): ((line: string) => void) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    // No file yet: the first line creates it.
  }
  return (line) => {
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text);
    if (size > 0 && size + bytes > maxBytes) {
      renameSync(file, `${file}.1`);
      size = 0;
    }
    appendFileSync(file, text, { mode: 0o600 });
    size += bytes;
  };
};

/**
 * Returns a layer that writes every line main logs to `file` as well, one
 * logfmt line each, beside the loggers already in place: what main prints to
 * stderr stays the same, because the end-to-end tests and the performance
 * script read it.
 *
 * Logging must never break what logged, so a line that cannot be written is
 * reported on stderr and dropped.
 */
export const makeMainLogLayer = (file: string): Layer.Layer<never> => {
  // The file is opened at the first line, so a launch that logs nothing touches no file.
  let append: ((line: string) => void) | undefined;
  const fileLogger = Logger.map(Logger.formatLogFmt, (line) => {
    try {
      append ??= openMainLog(file, MAX_MAIN_LOG_BYTES);
      append(line);
    } catch (error) {
      process.stderr.write(`Could not write to ${file}: ${String(error)}\n`);
    }
  });
  return Logger.layer([fileLogger], { mergeWithExisting: true });
};
