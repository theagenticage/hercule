import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Writes a file that another process may read at any moment, atomically: the
 * content goes to a temporary file beside `path`, which is then renamed to
 * `path`. Throws when the write fails, after deleting the temporary file.
 * Without this, a pi starting at the same moment could read a half-written
 * file: a session with no approval hook, half its instructions, or a model
 * list cut short.
 */
export const writeFileAtomically = (path: string, content: string | Uint8Array): void => {
  const written = `${path}.${process.pid}.${crypto.randomUUID()}`;
  try {
    writeFileSync(written, content, { mode: 0o600 });
    renameSync(written, path);
  } catch (error) {
    // A failed write can happen, but a partial temporary file with a unique
    // name would never be cleaned up, so delete it.
    rmSync(written, { force: true });
    throw error;
  }
};
