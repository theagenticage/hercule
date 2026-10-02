/**
 * The command-line arguments the packaged app starts with. It refuses every
 * argument that is not on a short list, because many of Chromium's switches
 * would let another program on the machine read the signed-in user's login
 * token, and nobody can list them all. For example:
 *
 * - `--remote-debugging-port` and `--remote-debugging-pipe` let a program
 *   drive the page, and the page holds the token;
 * - `--log-net-log` writes every request to a file, the token's
 *   `authorization` header included;
 * - `--proxy-server`, `--host-resolver-rules` and `--ignore-certificate-errors`
 *   send the app's requests, and the token with them, to another server;
 * - `--use-mock-keychain` makes Electron encrypt the stored token with a fixed
 *   key instead of one kept in the macOS Keychain, so anyone can decrypt it.
 *
 * The list holds whole arguments, and an argument that is not a switch is
 * refused too, because a switch cannot be told apart by how it starts:
 * Chromium trims spaces, tabs and newlines from each argument before it looks
 * for one, and reads `-x` as it reads `--x`. So ` --remote-debugging-port=0`,
 * with a leading space, opens the page to other programs just as the switch
 * does without it. macOS passes the app no argument when it opens it.
 *
 * The check runs when main starts, so it cannot undo a switch that Chromium
 * reads before that, such as `--js-flags`; the app exits right away, before
 * it reads the token or makes a request. The Electron fuses and the hardened
 * runtime remain the real guards against those.
 *
 * The refusal applies only when the Node inspector is closed. An open
 * inspector already gives full control of main, so the switches add nothing
 * there. The release package's fuses keep the inspector closed, so the
 * release package always refuses them; the test package, which the end-to-end
 * tests start with the inspector open, accepts them.
 *
 * This module imports nothing, so it runs in unit tests without Electron.
 */

/**
 * Checks whether the packaged app starts with `arg`. Only the end-to-end
 * tests pass these arguments:
 *
 * - `--user-data-dir=<folder>` gives each test its own folder. It exposes
 *   nothing: a program that can write a folder it names can write the app's
 *   own.
 * - `-ApplePersistenceIgnoreState` followed by `YES` is a macOS setting that
 *   keeps macOS from offering to reopen windows after a test stops the app.
 *   It only turns off window restoration, which the app does not use.
 */
const isAllowedArgument = (arg: string): boolean =>
  arg.startsWith("--user-data-dir=") || arg === "-ApplePersistenceIgnoreState" || arg === "YES";

/**
 * Returns the first argument in `args`, the arguments the app was started
 * with after the executable's path, that the app refuses, exactly as it was
 * given. Returns undefined when the app may start.
 *
 * - `packaged` is Electron's `app.isPackaged`. Development runs are never
 *   refused.
 * - `inspectorOpen` is whether the Node inspector is open. Pass the
 *   inspector's real state, `inspector.url() !== undefined`, rather than
 *   whether `--inspect` is on the command line, so that `--inspect` passed to
 *   a release package, whose fuses ignore it, does not get around the check.
 */
export const findRefusedArgument = (
  args: ReadonlyArray<string>,
  packaged: boolean,
  inspectorOpen: boolean,
): string | undefined =>
  packaged && !inspectorOpen ? args.find((arg) => !isAllowedArgument(arg)) : undefined;

/** The switch that names the Hercule binary main runs in place of the installed one. */
const BINARY_PATH_SWITCH = "--hercule-binary=";

/**
 * Returns the path the last `--hercule-binary=<path>` in `args` names, or
 * undefined when there is none, or when the app does not accept the switch.
 * `packaged` and `inspectorOpen` are as for findRefusedArgument.
 *
 * The end-to-end tests pass it to run a stand-in binary rather than the one
 * installed on the Mac. The switch is accepted only where findRefusedArgument
 * accepts every argument: in a development run, or with the inspector open.
 * A release package, whose fuses keep the inspector closed, refuses it, so
 * no other program can make the app run a binary of its choosing.
 */
export const readBinaryPathArgument = (
  args: ReadonlyArray<string>,
  packaged: boolean,
  inspectorOpen: boolean,
): string | undefined => {
  if (packaged && !inspectorOpen) return undefined;
  return args
    .findLast((arg) => arg.startsWith(BINARY_PATH_SWITCH))
    ?.slice(BINARY_PATH_SWITCH.length);
};
