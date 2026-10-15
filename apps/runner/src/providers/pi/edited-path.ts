/**
 * Reads the path of a file pi edits the way pi does, so the path recorded for
 * an edit is the file pi changed. pi's own rules live in its `resolveToCwd`
 * (pi-coding-agent 1.2.0); this file copies every step except the last one.
 */
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** The Unicode space characters pi replaces with an ordinary space. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Returns the home directory pi expands `~` to: the `HOME` of the environment
 * pi runs in, else the home of the runner's user. pi asks the operating system
 * for it, and on Linux and macOS that answer is `HOME` when it is set.
 */
export const readPiHome = (env: Readonly<Record<string, string | undefined>>): string => {
  const home = env["HOME"];
  return home === undefined || home === "" ? homedir() : home;
};

/**
 * Returns `path` as pi reads it, except that it is not made absolute. The
 * result is absolute, or relative to the session's working directory, which is
 * how the runner expects edited paths. The steps, in pi's order:
 *
 * 1. Every Unicode space becomes an ordinary space.
 * 2. One leading `@` is removed. Models write `@src/a.ts` to mean `src/a.ts`.
 * 3. `~` and a path that starts with `~/` start at `home`. `~user` does not.
 * 4. A `file://` URL becomes the path it names. A URL that cannot be
 *    converted is kept as written, as pi does.
 */
export const resolvePiPath = (path: string, home: string): string => {
  let result = path.replace(UNICODE_SPACES, " ");
  if (result.startsWith("@")) result = result.slice(1);
  if (result === "~") result = home;
  else if (result.startsWith("~/")) result = home + result.slice(1);
  if (result.startsWith("file://")) {
    try {
      result = fileURLToPath(result);
    } catch {
      // pi keeps the text when it is not a valid file URL.
    }
  }
  return result;
};
