/**
 * The kernel's file clock. The kernel stamps a file's ctime (the time its
 * metadata last changed) with a clock of its own, and that stamp is the only
 * trustworthy record of when a write happened: a process cannot forge it, and
 * `touch -t`, `cp -p` and an atomic rename all leave it true. The JavaScript
 * clock is a different clock. On Linux it was measured to disagree with the
 * file clock by up to 10 microseconds, in the direction that would misplace a
 * write. So every time the edit watch compares with a file's ctime, it reads
 * the time from a file's ctime too, with `takeMark()` below.
 *
 * `takeMark()` costs between 1 and 5 microseconds.
 */
import { fstatSync, futimesSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** A file whose ctime is read as "now" on the kernel's file clock. */
export interface FileClock {
  /**
   * Returns the time now on the file clock, in nanoseconds. It sets the
   * marker's times, which makes the kernel set its ctime to now, and reads the
   * ctime back. It fails only when the filesystem fails under an open file,
   * which the runner cannot recover from, so it throws.
   */
  readonly takeMark: () => bigint;
}

/**
 * Opens a marker file at `path`, creating it and its directory, and returns
 * the clock that reads its ctime. The file must sit outside every checkout,
 * so no listing of a checkout sees it, and stays open for the life of the
 * process. Throws when the file cannot be opened.
 */
export const openFileClock = (path: string): FileClock => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "w", 0o600);
  return {
    takeMark: () => {
      futimesSync(fd, 0, 0);
      return fstatSync(fd, { bigint: true }).ctimeNs;
    },
  };
};
