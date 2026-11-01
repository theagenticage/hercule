/**
 * Reads, copies and replaces the model list pi stores in a Harness Home
 * (`models-store.json`). Everything that runs pi in a scratch agent directory
 * (a text generation, a probe's listing of models, a model list refresh) starts
 * from a copy of the home's store, so pi sees neither whatever a session wrote
 * into the Harness Home (`models.json`, `APPEND_SYSTEM.md`) nor writes its own
 * bookkeeping files there.
 *
 * Only one thing ever changes the home's store: `replaceModelStore`, which
 * swaps in a whole file and is called while holding the home's launch lock. So
 * a reader sees a complete store, and a launch that holds the lock sees the
 * same store from its first read until its pi has loaded.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "./atomic-file";

const STORE_FILE = "models-store.json";

/**
 * Returns the bytes of the home's `models-store.json`, or undefined when the
 * home has none (never refreshed): pi then uses the list bundled in its
 * release. Throws when the file cannot be read for another reason.
 */
export const readModelStore = (home: string): Buffer | undefined => {
  try {
    return readFileSync(join(home, STORE_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
};

/**
 * Writes `store`, bytes that `readModelStore` returned, as `models-store.json`
 * in `directory`. Does nothing when `store` is undefined. Callers pass the
 * bytes they derived something from, so what pi loads is exactly what they
 * looked at.
 */
export const writeModelStore = (directory: string, store: Buffer | undefined): void => {
  if (store !== undefined) writeFileSync(join(directory, STORE_FILE), store, { mode: 0o600 });
};

/**
 * Replaces the home's `models-store.json` with the one in `directory`, which a
 * `pi update --models` refreshed there, by writing a temporary file in the home
 * and renaming it. Does nothing when `directory` has no store. Throws when the
 * copy fails, leaving the home's store as it was.
 *
 * The caller must hold the home's launch lock: a launch that holds it relies on
 * the store not changing until its pi has loaded.
 */
export const replaceModelStore = (directory: string, home: string): void => {
  const refreshed = readModelStore(directory);
  if (refreshed !== undefined) writeFileAtomically(join(home, STORE_FILE), refreshed);
};
