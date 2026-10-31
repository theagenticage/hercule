/**
 * Copies the model list pi stored in a Harness Home into a scratch agent
 * directory. Two callers need it: a text generation and a probe each run pi in
 * a scratch directory of their own, so that pi sees neither whatever a session
 * wrote into the Harness Home (`models.json`, `APPEND_SYSTEM.md`) nor writes
 * its own bookkeeping files there.
 */
import { copyFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Copies `models-store.json`, the model list `pi update --models` refreshed,
 * from the Harness Home `home` into `directory`. Does nothing when the home
 * has none (never probed): pi then uses the list bundled in its release.
 * Throws when the copy fails for another reason.
 *
 * pi writes the file in place, so a copy made during a refresh may be cut
 * short. pi then reports a model that only the stored list has as unknown for
 * that one run, which fails the run instead of picking another model.
 */
export const copyModelStore = (home: string, directory: string): void => {
  try {
    copyFileSync(join(home, "models-store.json"), join(directory, "models-store.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};
