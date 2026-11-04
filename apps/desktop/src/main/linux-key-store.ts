/**
 * The check that, on Linux, the login token is encrypted only with a key that
 * a real keyring keeps. Main loads this module the first time the token is
 * read or saved, not at launch, and only on Linux.
 *
 * This module imports only Electron's types, so unit tests can import it
 * without Electron.
 */
import type { ElectronSafeStorageCalls } from "./safe-storage";

/**
 * Throws an error unless `safeStorage` encrypts with a key that a
 * real keyring keeps. Does nothing when `fixedKeyForTests` is true.
 *
 * On Linux, Electron picks its backend from the desktop environment that
 * Chromium recognises (`XDG_CURRENT_DESKTOP` and similar variables). When it
 * recognises none it picks `basic_text`, which encrypts with one key written
 * in Electron's source, so anyone could decrypt the token. Electron 44 then
 * reports encryption as unavailable, unless `setUsePlainTextEncryption(true)`
 * was called, and older versions reported it as available. This check does
 * not depend on which: a backend that is not a keyring never encrypts the
 * token. It also fails when the backend is a keyring that is not running or
 * is locked, which Electron reports as unavailable.
 *
 * Electron selects the backend before the app is ready, so it is known
 * here. `isEncryptionAvailable` still runs before the backend is read: the
 * first call is what initialises the encryption and reaches the key, and so
 * reports whether the keyring answers.
 */
export const assertKeyringEncrypts = (
  safeStorage: ElectronSafeStorageCalls,
  fixedKeyForTests: boolean,
): void => {
  if (fixedKeyForTests) {
    // This only allows the fixed key; it does not select the backend. The
    // launch must also pass `--password-store=basic`, so that Electron does not
    // choose the real keyring of the desktop the test runs on.
    safeStorage.setUsePlainTextEncryption(true);
    return;
  }
  const available = safeStorage.isEncryptionAvailable();
  const backend = safeStorage.getSelectedStorageBackend();
  if (backend === "basic_text" || backend === "unknown") {
    throw new Error(
      `There is no keyring to keep the sign-in in. The desktop environment is not one that Electron recognises (it chose the "${backend}" backend), and that backend encrypts with a key anyone can read. Start the app in a desktop session that runs GNOME Keyring or KWallet, with XDG_CURRENT_DESKTOP set.`,
    );
  }
  if (!available) {
    throw new Error(
      `The keyring is not available (Electron chose the "${backend}" backend but cannot reach it). Start GNOME Keyring or KWallet and unlock it.`,
    );
  }
};
