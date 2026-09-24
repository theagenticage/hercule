/**
 * Builds the environment variables git runs with on this machine: which
 * credential helper to use, and which name and email to commit as.
 *
 * `GIT_CONFIG_COUNT` and its key/value pairs pass configuration to git without
 * a config file. Nothing is written to disk, and the settings last only as long
 * as the process that receives them.
 */
import { join as joinPath } from "node:path";

/** The path prefix Bun gives an entry script embedded in a compiled binary. */
const EMBEDDED = "/$bunfs/";

/** Matches a word that the shell would not read as one plain word, so it needs quoting. */
const QUOTABLE = /[^A-Za-z0-9_@%+=:,./-]/;

const quoteShellWord = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Returns the command line git runs as the credential helper. It starts with
 * the absolute path of the running executable, so git treats it as a command
 * rather than a helper name. git runs such a command through a shell, so the
 * arguments are quoted where needed.
 *
 * When running from source rather than the compiled binary, the executable is
 * Bun, so the entry script is passed as well. That way the helper also works
 * from a checkout.
 */
const buildHelperCommand = (): string =>
  [process.execPath, ...(Bun.main.startsWith(EMBEDDED) ? [] : [Bun.main]), "git-credential"]
    .map((word, at) => (at > 0 && QUOTABLE.test(word) ? quoteShellWord(word) : word))
    .join(" ");

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * Returns the environment variables that point git at the runner's credential
 * helper and socket, and set the commit identity when one is given.
 *
 * The empty `credential.helper` comes first because it clears the helpers git
 * inherited from the machine's own config. Otherwise one of those could supply
 * the machine owner's credential for any repository. `credential.useHttpPath`
 * stops one repository's token from being sent to another repository on the
 * same host.
 */
export const buildGitCredentialEnv = (options: {
  readonly socketPath: string;
  readonly identity?: GitIdentity | undefined;
}): Record<string, string> => {
  const pairs: Array<readonly [string, string]> = [
    ["credential.helper", ""],
    ["credential.helper", buildHelperCommand()],
    ["credential.useHttpPath", "true"],
    ...(options.identity === undefined
      ? []
      : ([
          ["user.name", options.identity.name],
          ["user.email", options.identity.email],
        ] as const)),
  ];
  return {
    HERCULE_RUNNER_SOCKET: options.socketPath,
    GIT_CONFIG_COUNT: String(pairs.length),
    ...Object.fromEntries(
      pairs.flatMap((pair, at) => [
        [`GIT_CONFIG_KEY_${String(at)}`, pair[0]],
        [`GIT_CONFIG_VALUE_${String(at)}`, pair[1]],
      ]),
    ),
  };
};

/** Returns the path of the daemon's Unix socket inside the runner's storage directory. */
export const buildSocketPath = (storageDir: string): string => joinPath(storageDir, "daemon.sock");
