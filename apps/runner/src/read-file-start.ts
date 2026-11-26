import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/**
 * Reads the start of the file at `path`, at most `buffer.length` bytes, into
 * `buffer` and returns the text of what was read and the file's full size.
 * Returns undefined when `path` is not a regular file. Throws a file system
 * error when the file cannot be opened or read.
 *
 * The file is opened without waiting and checked on the open descriptor, not
 * by its path. A named pipe that replaced the file between a look at the path
 * and this read would otherwise block the open forever, and with it the whole
 * runner. A text cut in the middle of a character ends in a replacement
 * character. The caller owns `buffer`, so one buffer can serve many files.
 */
export const readFileStart = (
  path: string,
  buffer: Buffer,
): { readonly text: string; readonly bytesRead: number; readonly size: number } | undefined => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return undefined;
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    return { text: buffer.toString("utf8", 0, length), bytesRead: length, size: stats.size };
  } finally {
    closeSync(descriptor);
  }
};
