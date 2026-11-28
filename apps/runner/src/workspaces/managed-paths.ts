/** Path checks shared by the removal of a workspace and the removal of its checkouts. */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import * as Effect from "effect/Effect";
import type { Substrate } from "./substrate";

/** Returns the error itself, or an error that carries the thrown value's text. */
export const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** Checks that `child` lies strictly below `parent`. */
export const isInsideDirectory = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
};

/** Checks that a recorded managed path still names the runner's original storage location. */
export const validateManagedPath = (
  substrate: Substrate,
  path: string,
): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      const storage = realpathSync(substrate.storageDir);
      const expected = resolve(storage, relative(resolve(substrate.storageDir), resolve(path)));
      if (!isInsideDirectory(storage, expected))
        throw new Error(
          "The recorded workspace path is outside managed storage. Preserve its files and restore its registry.",
        );
      let ancestor = resolve(path);
      while (ancestor !== resolve(substrate.storageDir)) {
        try {
          const physical = lstatSync(ancestor);
          const expectedAncestor = resolve(
            storage,
            relative(resolve(substrate.storageDir), ancestor),
          );
          if (physical.isSymbolicLink() || realpathSync(ancestor) !== expectedAncestor)
            throw new Error(
              "The recorded managed directory or one of its parent directories was replaced or redirected. Preserve its files and restore the original workspace.",
            );
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          ancestor = dirname(ancestor);
        }
      }
    },
    catch: normalizeError,
  });
