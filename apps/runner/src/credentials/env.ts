/**
 * The environment git is given on this machine: which helper to ask, and who to
 * say it is.
 *
 * `GIT_CONFIG_COUNT` and its pairs are how configuration reaches git without a
 * file: nothing Hercule sets is written to disk, and nothing it sets outlives the
 * process it was given to.
 */
import { join as joinPath } from "node:path";

/** Bun's own marker for an entry script that lives inside a compiled binary. */
const EMBEDDED = "/$bunfs/";

/** A word the shell git runs the helper through would read as more than a word. */
const QUOTABLE = /[^A-Za-z0-9_@%+=:,./-]/;

const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The helper, as an absolute command. git runs a `credential.helper` that looks
 * like a path through a shell, so the arguments are quoted; the interpreter's
 * own path leads the line, because that is what makes it absolute.
 *
 * Uncompiled, the interpreter is Bun and the script has to be named: that is
 * what makes the helper work from a checkout as well as from the binary.
 */
const helperCommand = (): string =>
  [process.execPath, ...(Bun.main.startsWith(EMBEDDED) ? [] : [Bun.main]), "git-credential"]
    .map((word, at) => (at > 0 && QUOTABLE.test(word) ? quoted(word) : word))
    .join(" ");

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * The empty `credential.helper` comes first: git reads helpers in order, and an
 * inherited one would otherwise answer with the machine owner's credential, for
 * any repository. `credential.useHttpPath` is what keeps one repository's token
 * from being sent to another on the same host.
 */
export const gitCredentialEnv = (options: {
  readonly socketPath: string;
  readonly identity?: GitIdentity | undefined;
}): Record<string, string> => {
  const pairs: Array<readonly [string, string]> = [
    ["credential.helper", ""],
    ["credential.helper", helperCommand()],
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

/** Where the daemon listens, under the runner's own storage directory. */
export const socketPathIn = (storageDir: string): string => joinPath(storageDir, "daemon.sock");
