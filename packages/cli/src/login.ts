/**
 * `hercule login <url>`.
 *
 * Logging in takes two calls, on purpose: `auth.login` exchanges the password
 * for a 30-day bearer token, and `apiKey.create` uses that token to create a
 * long-lived API key. The key is stored in `credentials.json`; the bearer is
 * revoked and never written to disk. No login mode returns a long-lived key
 * directly, so creating a key stays an ordinary authenticated operation.
 *
 * The password comes from stdin (`--password-stdin`) or, on a terminal only,
 * from an echo-off prompt, the only exception to "the CLI never prompts".
 * There is no `--password` flag: its value would be visible in `ps` and in
 * shell history.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createClient, type HerculeClient } from "@hercule/client-core";
import { locateCredentialsFile } from "@hercule/home";
import { tokenize } from "./commands/args";
import { UsageError } from "./exit";
import type { Io } from "./io";

export interface LoginResult {
  readonly url: string;
  readonly apiKeyId: string;
  readonly name: string;
  readonly path: string;
}

const HELP = [
  "usage: hercule login <url> --username <name> [--password-stdin] [--name <key-name>] [--json]",
  "",
  "Logs in with a password and stores a long-lived API key in <home>/credentials.json,",
  "mode 0600. Two calls: auth.login for a 30-day bearer, then apiKey.create under it.",
  "The bearer is revoked before this exits and never touches disk.",
  "",
  "arguments:",
  "  <url>  the controller's origin, e.g. http://127.0.0.1:4937",
  "",
  "flags:",
  "  --username <name>  required",
  "  --password-stdin   read the password from stdin; without it, and only on a",
  "                     terminal, the password is prompted for with echo off",
  "  --name <key-name>  the API key's name in Settings; defaults to this machine's hostname",
  "  --json             print { url, apiKeyId, name }; the key itself is never printed",
];

/** Returns the help text of `hercule login`, one line per entry. */
export const getLoginHelp = (): ReadonlyArray<string> => HELP;

/**
 * Returns the URL without a trailing slash. Throws a `UsageError` unless it is
 * an http or https URL.
 */
const normalizeUrl = (text: string): string => {
  if (!/^https?:\/\//.test(text)) {
    throw new UsageError(
      `${text} is not a controller URL: it must start with http:// or https://`,
      "login",
    );
  }
  return text.replace(/\/+$/, "");
};

/**
 * Writes `{ url, apiKey }` to the credential file, readable only by this OS
 * user. Returns the file's path.
 *
 * It never writes into the target file directly. `writeFileSync`'s `mode`
 * applies only when it creates a file, so writing over an existing
 * world-readable `credentials.json` would leave the new key readable until a
 * later `chmod`, and any local process could read it in that window. A new
 * file in the same directory is 0600 from its first byte, and renaming it
 * over the target replaces the credential atomically.
 */
const writeCredentials = (home: string, url: string, apiKey: string): string => {
  const path = locateCredentialsFile(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ url, apiKey }, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
};

/**
 * Runs `hercule login` with the tokens after `login`. Returns what was stored.
 * Throws a `UsageError` for a bad command line, and an `ApiError` when a call
 * to the controller fails.
 */
export const login = async (
  tokens: ReadonlyArray<string>,
  home: string,
  io: Io,
): Promise<LoginResult & { readonly json: boolean }> => {
  let url: string | undefined;
  let username: string | undefined;
  let name: string | undefined;
  let passwordStdin = false;
  let json = false;

  for (const token of tokenize(tokens, "login")) {
    if (token.kind === "positional") {
      if (url !== undefined) throw new UsageError("login takes one argument: <url>", "login");
      url = normalizeUrl(token.text);
      continue;
    }
    const { name: flag, value } = token;

    if (flag === "username") username = value();
    else if (flag === "name") name = value();
    else if (flag === "password-stdin") passwordStdin = true;
    else if (flag === "json") json = true;
    else if (flag === "password") {
      throw new UsageError(
        "--password does not exist: it would be visible in process lists and in shell history. Use --password-stdin.",
        "login",
      );
    } else throw new UsageError(`unknown flag --${flag}`, "login");
  }

  if (url === undefined)
    throw new UsageError("login needs the controller URL: hercule login <url>", "login");
  if (username === undefined) throw new UsageError("login needs --username <name>", "login");

  let password: string;
  if (passwordStdin) {
    // Strip one trailing `\n` or `\r\n`, as for every other field read from stdin.
    password = (await io.stdin()).replace(/\r?\n$/, "");
  } else if (io.isTty()) {
    password = await io.prompt("password: ");
  } else {
    throw new UsageError(
      "no password was given, and there is no terminal to prompt on. Pipe the password in with --password-stdin.",
      "login",
    );
  }
  if (password === "") throw new UsageError("the password is empty", "login");

  const client: HerculeClient = createClient({ baseUrl: url, fetch: io.fetch });

  const bearer = (await client.auth.login({ payload: { username, password } })) as {
    readonly token: string;
  };
  client.setToken(bearer.token);

  const keyName = name ?? io.hostname();
  try {
    const key = (await client.apiKey.create({ payload: { name: keyName } })) as {
      readonly id: string;
      readonly name: string;
      readonly token: string;
    };
    const path = writeCredentials(home, url, key.token);
    return { url, apiKeyId: key.id, name: key.name, path, json };
  } finally {
    // The bearer token is no longer needed. Revoking it is best effort: a login
    // that succeeded must not fail because the cleanup call failed.
    await client.auth.logout().catch(() => undefined);
  }
};
