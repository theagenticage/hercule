/**
 * Where the CLI gets its controller URL and its bearer token.
 *
 * There are two sources, always read in this order:
 *
 * - the environment. Inside a session, the runner sets `HERCULE_API_URL` and
 *   `HERCULE_TOKEN`.
 * - `<home>/credentials.json`, which `hercule login` writes for the user's own
 *   shell.
 *
 * `HERCULE_SESSION=1` marks a process the runner started. The file is then
 * never read, not just read last, so an agent whose environment token is
 * missing or expired fails instead of silently acting as the user.
 */
import { readFileSync } from "node:fs";
import { isInSession, locateCredentialsFile, type Env } from "@hercule/home";

/** The contents of `<home>/credentials.json`, exactly as `hercule login` writes it. */
export interface CredentialFile {
  readonly url: string;
  readonly apiKey: string;
}

/** Where a resolved credential came from. Error messages for people name it. */
export type CredentialSource = "environment" | "file";

export interface Credential {
  readonly url: string;
  readonly token: string;
  readonly source: CredentialSource;
}

/** A credential could not be resolved. The message names the source that failed, and why. */
export class CredentialError extends Error {
  override readonly name = "CredentialError";
}

/**
 * Reads the credential file. Returns `undefined` when the file cannot be read,
 * for example because it does not exist.
 *
 * A malformed file throws a `CredentialError` rather than counting as "no
 * credential": it is a broken state the user has to see, not a reason to
 * continue without a credential.
 */
const readCredentialFile = (path: string): CredentialFile | undefined => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CredentialError(`${path} is not valid JSON. Run \`hercule login <url>\` again.`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CredentialError(
      `${path} is not a credential file. Run \`hercule login <url>\` again.`,
    );
  }
  const { url, apiKey } = parsed as { url?: unknown; apiKey?: unknown };
  if (typeof url !== "string" || url === "" || typeof apiKey !== "string" || apiKey === "") {
    throw new CredentialError(
      `${path} has no \`url\` and \`apiKey\`. Run \`hercule login <url>\` again.`,
    );
  }
  return { url, apiKey };
};

/**
 * Returns the controller URL and the token to send. Throws a `CredentialError`
 * that says what to do when there is no usable credential.
 *
 * `home` is the Hercule Home, already resolved, so `--home` and `HERCULE_HOME`
 * are handled by the same parser every role uses.
 */
export const resolveCredential = (home: string, env: Env): Credential => {
  const token = env["HERCULE_TOKEN"];
  const envUrl = env["HERCULE_API_URL"];

  if (token !== undefined && token !== "") {
    if (envUrl === undefined || envUrl === "") {
      throw new CredentialError(
        "HERCULE_TOKEN is set but HERCULE_API_URL is not. Set both, or neither.",
      );
    }
    return { url: envUrl, token, source: "environment" };
  }

  // The two sources are never mixed. A lone HERCULE_API_URL would otherwise
  // send the file's long-lived API key to a host it was not created for. So it
  // is an error rather than ignored: a stale variable is a misconfiguration
  // the user has to see.
  if (envUrl !== undefined && envUrl !== "") {
    throw new CredentialError(
      "HERCULE_API_URL is set but HERCULE_TOKEN is not. Unset HERCULE_API_URL, or set both. The credential file's key is only ever sent to the controller that created it.",
    );
  }

  const path = locateCredentialsFile(home);

  if (isInSession(env)) {
    throw new CredentialError(
      `HERCULE_SESSION=1 is set but HERCULE_TOKEN is not. Inside a session the CLI does not read the credential file (${path}), so it cannot act as the user by accident.`,
    );
  }

  const file = readCredentialFile(path);
  if (file === undefined) {
    throw new CredentialError(
      `No credential. Set HERCULE_TOKEN and HERCULE_API_URL, or run \`hercule login <url>\`.`,
    );
  }
  // A non-empty HERCULE_API_URL threw above, so the file's own URL is the
  // only one left: a file credential is never sent to a controller that did
  // not create it.
  return { url: file.url, token: file.apiKey, source: "file" };
};

/**
 * Returns only the controller URL. Used for the two operations that need no
 * credential (`setup.read`, `auth.login`) and for `setup.complete`, which
 * sends a setup token instead. Throws a `CredentialError` when no URL is
 * found.
 */
export const resolveUrl = (home: string, env: Env): string => {
  const envUrl = env["HERCULE_API_URL"];
  if (envUrl !== undefined && envUrl !== "") return envUrl;
  if (isInSession(env)) {
    throw new CredentialError(
      "HERCULE_SESSION=1 is set but HERCULE_API_URL is not. Set HERCULE_API_URL.",
    );
  }
  const file = readCredentialFile(locateCredentialsFile(home));
  if (file === undefined) {
    throw new CredentialError(
      `No controller URL. Set HERCULE_API_URL, or run \`hercule login <url>\`.`,
    );
  }
  return file.url;
};
