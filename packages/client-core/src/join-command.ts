/** Characters a POSIX shell passes through unchanged in a word. */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/;

/**
 * Returns `word` as one argument of a POSIX shell command. A word made only
 * of letters, digits and `-_./:@%+=,` is returned as it is, so an ordinary
 * address and token stay readable. Any other word is put in single quotes,
 * with each single quote inside it written as `'\''`. An address such as
 * `http://[::1]:4937` needs this: zsh reads `[` as a pattern and fails.
 */
const quoteShellWord = (word: string): string =>
  SHELL_SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Builds the command the Fleet screen shows for adding a machine as a runner,
 * ready to paste into a POSIX shell: the address and the token are quoted
 * when they hold anything a shell would read as syntax.
 *
 * The controller address in the command is the one this browser is talking to,
 * not the address the controller reports for itself. An address that works
 * from this browser is most likely one the operator can paste and use.
 *
 * `--reserved` adds a runner that only runs work sent to it by name.
 */
export const joinCommand = ({
  origin,
  token,
  reserved,
}: {
  readonly origin: string;
  readonly token: string;
  readonly reserved: boolean;
}): string =>
  `hercule runner join ${quoteShellWord(origin)} --token ${quoteShellWord(token)}${reserved ? " --reserved" : ""}`;
