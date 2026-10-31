/**
 * The scratch folders of `claude setup-token`. A login removes its folder when
 * it ends, but a runner killed in the middle of one cannot. This module names
 * the folders and sweeps those a dead runner left.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import { LOGIN_IDLE } from "./login";

/** The start of the name of every scratch folder of a token login. */
export const SETUP_TOKEN_FOLDER_PREFIX = "hercule-setup-token-";

/**
 * Removes the token login scratch folders in `tempDir` that were last changed
 * more than `LOGIN_IDLE` before `now` (milliseconds on this machine's clock).
 * A login that old has been killed by its idle limit, so its folder belongs to
 * a runner that died. A younger folder may belong to a login that is still
 * running, in another runner on this machine, and stays. Never fails: a folder
 * that cannot be read or removed is left alone.
 */
export const removeStaleSetupTokenFolders = (tempDir: string, now: number): void => {
  let names: ReadonlyArray<string>;
  try {
    names = readdirSync(tempDir);
  } catch {
    return;
  }
  const oldest = now - Duration.toMillis(LOGIN_IDLE);
  for (const name of names) {
    if (!name.startsWith(SETUP_TOKEN_FOLDER_PREFIX)) continue;
    const folder = join(tempDir, name);
    try {
      if (statSync(folder).mtimeMs < oldest) rmSync(folder, { recursive: true, force: true });
    } catch {
      // The folder is gone already or cannot be touched; nothing to do.
    }
  }
};
