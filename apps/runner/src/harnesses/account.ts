/**
 * What every adapter does with the Provider Account a frame carries: where its
 * Harness Home is on this machine, how a model is named to the harness, and
 * where the credential goes in the harness's environment. These are the same
 * for every harness, because the controller sends the account's own forms of
 * them (spec 06 section 10.4).
 */
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessAccount, HarnessHome } from "@hercule/protocol";

/**
 * Returns the absolute folder of a Harness Home without creating it. The home
 * is the folder the controller named, joined to the runner's storage
 * directory; the runner never works one out from an account id. The protocol
 * accepts only homes that stay under the storage directory, so the join cannot
 * leave it.
 */
export const buildHarnessHomePath = (storageDir: string, harnessHome: HarnessHome): string =>
  join(storageDir, harnessHome);

/**
 * Returns the absolute folder of a Harness Home, which it creates with mode
 * 0700 when it is missing. Fails when a folder on the way down is a link or
 * not a folder, with a message that names its path.
 *
 * The check walks the components of `harnessHome` one by one, from the
 * storage directory down, and requires each to be a real folder, not a link.
 * A link is refused even when it points back inside the storage directory,
 * because it would make two Provider Accounts share one Harness Home: one
 * account's login, sessions and probe results would serve the other.
 *
 * What this protects against: a link that already stands in the runner's
 * storage, made by mistake or left by another tool, which every harness would
 * otherwise follow without a word.
 *
 * What it does not protect against:
 *
 * - A process of the runner's own user that writes into the storage directory
 *   while this runs or afterwards. It can already read every Harness Home. It
 *   can also replace a folder with a link after it was checked, either during
 *   this walk or before the harness first uses the Home. The check holds only
 *   while the storage tree stays as it is.
 * - The storage directory itself and the folders above it. They are the
 *   runner's own location and may be links on purpose (`/home` on some systems).
 * - Links inside a Harness Home. What a harness or an adapter keeps there is
 *   theirs to check.
 */
export const createHarnessHome = (storageDir: string, harnessHome: HarnessHome): string => {
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  let folder = storageDir;
  for (const component of harnessHome.split("/")) {
    folder = join(folder, component);
    // One level at a time and without `recursive`, so each folder is looked at
    // right after it is made or found, before the next one is made below it.
    try {
      mkdirSync(folder, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(folder);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `The Harness Home folder ${folder} is a link, not a real folder. The runner does not ` +
          "follow links in its storage directory. Remove the link and try again.",
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`The Harness Home path ${folder} is not a folder. Remove it and try again.`);
    }
  }
  return folder;
};

/**
 * Returns the model as the harness is told to name it: the account's model
 * argument with `{model}` replaced by the model id (`zai/{model}` and `glm-5.3`
 * give `zai/glm-5.3`).
 */
export const formatModelArgument = (modelArgument: string, model: string): string =>
  // A function, so a `$` in a model id is never read as a replacement pattern.
  modelArgument.replace("{model}", () => model);

/**
 * Returns the environment for the harness process with the account's
 * credential applied, as a copy:
 *
 * - every variable in `credentialVariables` is removed first, so a key of the
 *   runner's own (an `ANTHROPIC_API_KEY` in its shell) never stands in for the
 *   account's login, or for the key the account does not have;
 * - then, when the account has a credential, its variable is set to the key.
 *
 * The key goes in the environment of the harness process and nowhere else:
 * never to disk and never to a log.
 */
export const applyCredential = (
  env: Readonly<Record<string, string | undefined>>,
  account: Pick<HarnessAccount, "credentialVariables" | "credential">,
): Record<string, string | undefined> => {
  const applied = { ...env };
  for (const variable of account.credentialVariables) delete applied[variable];
  if (account.credential !== undefined) {
    applied[account.credential.variable] = account.credential.value;
  }
  return applied;
};
