/**
 * The check that, on Linux, the login token is encrypted only with a key that
 * a real keyring keeps. Main loads this module the first time the token is
 * read or saved, not at launch, and only on Linux.
 *
 * This module imports only Electron's types, so unit tests can import it
 * without Electron.
 */
import inspector from "node:inspector";
import type { ElectronSafeStorageCalls } from "./safe-storage";

/**
 * What the sheet tells the user to do. A keyring is any Secret Service, and
 * the app never installs or starts one itself.
 */
const KEYRING_ADVICE =
  "Install a keyring such as gnome-keyring or KeePassXC, and keep it unlocked.";

/** What is wrong with the key store: the text for the log, and a sentence for the user. */
export interface KeyringProblem {
  readonly message: string;
  readonly advice: string;
}

/** The switch that asks for the key store to be replaced by a fixed key. */
const MOCK_KEYCHAIN_SWITCH = "--use-mock-keychain";

/**
 * Returns what is wrong when `safeStorage` would not encrypt with a key that
 * a real keyring keeps, or undefined when it would. Returns undefined without looking at the key
 * store when an end-to-end test asked for the mock keychain.
 *
 * On Linux, Chromium picks its backend from the desktop it recognises. When
 * it picks `basic_text`, which encrypts with one key written in Electron's
 * source, anyone could decrypt the token. Electron 44 then reports encryption
 * as unavailable, unless `setUsePlainTextEncryption(true)` was called, and
 * older versions reported it as available. This check does not depend on
 * which: a backend that is not a keyring never encrypts the token. It also
 * reports a keyring that is not running, or is locked and was not unlocked,
 * which Electron reports as unavailable.
 *
 * Electron selects the backend before the app is ready, so it is known
 * here. `isEncryptionAvailable` still runs before the backend is read: the
 * first call is what initialises the encryption and reaches the key, and so
 * reports whether the keyring answers. When the keyring is locked, that call
 * blocks main while the keyring asks the user to unlock it.
 *
 * The end-to-end tests pass `--use-mock-keychain`, so that no test touches a
 * real keyring or needs one. Chromium reads the switch itself on macOS; on
 * Linux it does nothing, and this function turns it into Electron's fixed-key
 * mode, `setUsePlainTextEncryption(true)`, but only while the Node inspector
 * is open: a token encrypted with a fixed key is readable by any program, and
 * the release package's fuses keep the inspector closed. `args` are the
 * command-line arguments after the executable's path, and `inspectorOpen` is
 * the inspector's real state, not whether `--inspect` is on the command line.
 * The launch must also pass `--password-store=basic`, so that Electron does
 * not choose the real keyring of the desktop the test runs on.
 */
export const findKeyringProblem = (
  safeStorage: ElectronSafeStorageCalls,
  args: ReadonlyArray<string> = process.argv.slice(1),
  inspectorOpen: boolean = inspector.url() !== undefined,
): KeyringProblem | undefined => {
  if (inspectorOpen && args.includes(MOCK_KEYCHAIN_SWITCH)) {
    // This only allows the fixed key; it does not select the backend.
    safeStorage.setUsePlainTextEncryption(true);
    return undefined;
  }
  const available = safeStorage.isEncryptionAvailable();
  const backend = safeStorage.getSelectedStorageBackend();
  if (backend === "basic_text" || backend === "unknown") {
    return {
      message: `There is no keyring to keep the sign-in in: Electron chose the "${backend}" backend, which encrypts with a key anyone can read.`,
      advice: KEYRING_ADVICE,
    };
  }
  if (!available) {
    return {
      message: `The keyring is not available: Electron chose the "${backend}" backend but could not reach it, because no keyring is running or it is locked and was not unlocked.`,
      advice: KEYRING_ADVICE,
    };
  }
  return undefined;
};
