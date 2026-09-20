/**
 * Where the CLI gets its controller URL and its bearer token.
 *
 * Two sources, in one fixed order: the environment, then
 * `<home>/credentials.json`. The environment is what a session gets - the
 * runner injects `HERCULE_API_URL` and `HERCULE_TOKEN` - and the file is what
 * `hercule login` wrote for the user's own shell.
 *
 * `HERCULE_SESSION=1` marks a process the runner started. The file is then
 * refused outright rather than merely deprioritised, so an agent whose
 * environment token is missing or expired fails instead of silently acting as
 * the user.
 */
import { readFileSync } from "node:fs";
import { credentialsFileIn } from "@hercule/home";

/** The contents of `<home>/credentials.json`, exactly as `hercule login` writes it. */
export interface CredentialFile {
  readonly url: string;
  readonly apiKey: string;
}

/** Where a resolved credential came from; what the human error messages name. */
export type CredentialSource = "environment" | "file";

export interface Credential {
  readonly url: string;
  readonly token: string;
  readonly source: CredentialSource;
}

/** A credential could not be resolved. The message says which source failed and why. */
export class CredentialError extends Error {
  override readonly name = "CredentialError";
}

export type Env = Readonly<Record<string, string | undefined>>;

/** True when this process was started by the runner inside a session. */
export const inSession = (env: Env): boolean => env["HERCULE_SESSION"] === "1";

/**
 * Read the credential file, or `undefined` when there is none.
 *
 * An unreadable or malformed file is an error rather than "no credential": it
 * is a broken state the user has to see, not a fallback to anonymity.
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
 * The controller URL and the token to send, or a `CredentialError` saying what
 * to do about it.
 *
 * `home` is the already-resolved Hercule Home, so `--home` and `HERCULE_HOME` are
 * honoured by the one parser every role runs.
 */
export const resolveCredential = (home: string, env: Env): Credential => {
  const token = env["HERCULE_TOKEN"];
  const envUrl = env["HERCULE_API_URL"];

  if (token !== undefined && token !== "") {
    if (envUrl === undefined || envUrl === "") {
      throw new CredentialError(
        "HERCULE_TOKEN is set but HERCULE_API_URL is not. Set both, or none.",
      );
    }
    return { url: envUrl, token, source: "environment" };
  }

  // The two sources are never blended. A lone HERCULE_API_URL would otherwise
  // send the file's long-lived API key to a host it was never minted for, so it
  // is refused rather than ignored: a stale variable is a misconfiguration the
  // user has to see.
  if (envUrl !== undefined && envUrl !== "") {
    throw new CredentialError(
      "HERCULE_API_URL is set but HERCULE_TOKEN is not; unset it or set both. The credential file's key is only ever sent to the controller it was minted for.",
    );
  }

  const path = credentialsFileIn(home);

  if (inSession(env)) {
    throw new CredentialError(
      `HERCULE_SESSION=1 and no HERCULE_TOKEN. Inside a session the CLI refuses the credential file (${path}), so it cannot act as the user by accident.`,
    );
  }

  const file = readCredentialFile(path);
  if (file === undefined) {
    throw new CredentialError(
      `No credential. Set HERCULE_TOKEN and HERCULE_API_URL, or run \`hercule login <url>\`.`,
    );
  }
  // A non-empty HERCULE_API_URL threw above, so the file's own URL is the only
  // one left: a file credential is never sent to a controller it was not
  // minted for.
  return { url: file.url, token: file.apiKey, source: "file" };
};

/**
 * The controller URL alone, for the two operations that need no credential
 * (`setup.read`, `auth.login`) and for `setup.complete`, which carries a setup
 * token instead.
 */
export const resolveUrl = (home: string, env: Env): string => {
  const envUrl = env["HERCULE_API_URL"];
  if (envUrl !== undefined && envUrl !== "") return envUrl;
  if (inSession(env)) {
    throw new CredentialError("HERCULE_SESSION=1 and no HERCULE_API_URL. Set HERCULE_API_URL.");
  }
  const file = readCredentialFile(credentialsFileIn(home));
  if (file === undefined) {
    throw new CredentialError(
      `No controller URL. Set HERCULE_API_URL, or run \`hercule login <url>\`.`,
    );
  }
  return file.url;
};
