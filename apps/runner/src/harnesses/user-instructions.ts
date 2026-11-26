/**
 * Reads the user's own instruction files, such as the `AGENTS.md` of Codex, into
 * the text a harness adds to a Thread's instructions. The runner finds the
 * files (see `user-material/`) and the adapters of the harnesses that take
 * their instructions as text (Codex and Antigravity) call this each time a
 * session starts, resumes or forks, so the Thread always gets the current text.
 */
import * as Effect from "effect/Effect";
import { readFileStart } from "../read-file-start";
import { describeError, escapeControlCharacters } from "../report";

/**
 * The most bytes read from one instruction file. Codex itself loads at most
 * 32 KiB of an `AGENTS.md` by default, and Antigravity cuts a rule at 24 KB,
 * so a larger file is not something the harness would load whole. Reading
 * more would stall the runner and bloat the Thread's instructions.
 */
const MAX_INSTRUCTIONS_FILE_BYTES = 64 * 1024;

/**
 * The most bytes read from all instruction files of one Thread together. A
 * user can have many rule files, and the sum must stay small too.
 */
const MAX_INSTRUCTIONS_TOTAL_BYTES = 256 * 1024;

/**
 * Reads the user's own instruction files and returns their texts in the given
 * order, joined by a blank line. Returns `undefined` when `paths` is empty or
 * no file could be read. Texts that are only white space are left out.
 *
 * Reads at most `MAX_INSTRUCTIONS_FILE_BYTES` of a file and
 * `MAX_INSTRUCTIONS_TOTAL_BYTES` of all files. The rest is dropped, and a
 * warning names the file and how many bytes were left out.
 *
 * Never fails. A path that is not a regular file, or that cannot be read, is
 * skipped and logs a warning with the path and the reason, never the file's
 * text. A Thread never fails to start because of the user's own files (spec 06
 * section 9.1). The files are read again on every call, so a resumed or
 * forked Thread gets the current text.
 */
export const readUserInstructions = (
  paths: ReadonlyArray<string>,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    // A file name can hold a line break, which would forge a log line.
    const warn = (message: string) => Effect.logWarning(escapeControlCharacters(message));
    const buffer = Buffer.alloc(MAX_INSTRUCTIONS_FILE_BYTES);
    const texts: Array<string> = [];
    let totalBytes = 0;
    for (const path of paths) {
      const room = MAX_INSTRUCTIONS_TOTAL_BYTES - totalBytes;
      if (room <= 0) {
        yield* warn(
          `Left ${path} out of the Thread's instructions: the files before it already fill the limit of ${String(MAX_INSTRUCTIONS_TOTAL_BYTES / 1024)} KiB`,
        );
        continue;
      }
      const file = yield* Effect.try({
        try: () => {
          const start = readFileStart(path, buffer.subarray(0, room));
          if (start === undefined) throw new Error("it is not a regular file");
          return start;
        },
        catch: describeError,
      }).pipe(
        Effect.catch((reason) =>
          Effect.as(
            warn(`Did not read ${path} into the Thread's instructions: ${reason}`),
            undefined,
          ),
        ),
      );
      if (file === undefined) continue;
      if (file.size > file.bytesRead) {
        yield* warn(
          `Cut ${path} in the Thread's instructions: left out the last ${String(file.size - file.bytesRead)} of its ${String(file.size)} bytes, because of the limit of ${String(MAX_INSTRUCTIONS_FILE_BYTES / 1024)} KiB per file and ${String(MAX_INSTRUCTIONS_TOTAL_BYTES / 1024)} KiB in all`,
        );
      }
      if (file.text.trim() === "") continue;
      texts.push(file.text);
      totalBytes += file.bytesRead;
    }
    return texts.length === 0 ? undefined : texts.join("\n\n");
  });
