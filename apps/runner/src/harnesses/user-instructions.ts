import { readFileSync, statSync } from "node:fs";
import * as Effect from "effect/Effect";
import { describeError } from "../report";

/**
 * Reads the user's own instruction files and returns their texts in the given
 * order, joined by a blank line. Returns `undefined` when `paths` is empty or
 * no file could be read. Texts that are only white space are left out.
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
    const texts: Array<string> = [];
    for (const path of paths) {
      const text = yield* Effect.try({
        try: () => {
          if (!statSync(path).isFile()) throw new Error("it is not a regular file");
          return readFileSync(path, "utf8");
        },
        catch: describeError,
      }).pipe(
        Effect.catch((reason) =>
          Effect.as(
            Effect.logWarning(`Did not read ${path} into the Thread's instructions: ${reason}`),
            undefined,
          ),
        ),
      );
      if (text !== undefined && text.trim() !== "") texts.push(text);
    }
    return texts.length === 0 ? undefined : texts.join("\n\n");
  });
