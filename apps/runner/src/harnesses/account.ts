/**
 * What every adapter does with the Provider Account a frame carries: where its
 * Harness Home is on this machine, how a model is named to the harness, and
 * where the credential goes in the harness's environment. These are the same
 * for every harness, because the controller sends the account's own forms of
 * them (spec 06 section 10.4).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessCredential, HarnessHome } from "@hercule/protocol";

/**
 * Returns the absolute folder of a Harness Home, which it creates with mode
 * 0700 when it is missing. The home is the folder the controller named,
 * joined to the runner's storage directory; the runner never works one out
 * from an account id. The protocol accepts only homes that stay under the
 * storage directory, so the join cannot leave it.
 */
export const createHarnessHome = (storageDir: string, harnessHome: HarnessHome): string => {
  const home = join(storageDir, harnessHome);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
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
 * - with a key, the variable the harness reads it from is set to the key;
 * - with a variable but no key, the variable is removed, so a key of the
 *   runner's own never stands in for an account that has none;
 * - without a credential, the environment is unchanged.
 *
 * The key goes in the environment of the harness process and nowhere else:
 * never to disk and never to a log.
 */
export const applyCredential = (
  env: Readonly<Record<string, string | undefined>>,
  credential: HarnessCredential | undefined,
): Record<string, string | undefined> => {
  const applied = { ...env };
  if (credential === undefined) return applied;
  if (credential.value === undefined) delete applied[credential.variable];
  else applied[credential.variable] = credential.value;
  return applied;
};
