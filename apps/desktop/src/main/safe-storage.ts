/**
 * Encryption with a key the system keeps for the app, which main uses to
 * store the login token: in the Keychain on macOS, in the keyring (GNOME
 * Keyring or KWallet) on Linux. Electron's `safeStorage` does the work; this
 * service wraps it so that the code which stores the token can be tested with
 * a fake.
 *
 * This module imports only Electron's types. The layer takes Electron's
 * `safeStorage` as an argument, so unit tests can import the module without
 * Electron.
 */
import type { SafeStorage as ElectronSafeStorage } from "electron";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DesktopPlatform } from "../ipc/platform/desktop-platform";
import { PLATFORM_BEHAVIOUR } from "./platform-behaviour";

/**
 * The error encryption or decryption fails with: the system's key store (the
 * Keychain or the keyring) is not available or denied access to its key, or
 * the data was encrypted with another key. `message` says which, and is
 * written for the log.
 */
export class KeyStoreError extends Data.TaggedError("KeyStoreError")<{
  readonly message: string;
}> {}

/** Encryption and decryption of text with the system key store's key. */
export class SafeStorage extends Context.Service<
  SafeStorage,
  {
    /**
     * What the platform calls its key store, for messages to the user: the
     * Keychain or the keyring.
     */
    readonly keyStoreName: "Keychain" | "keyring";
    /** Encrypts `text`. Fails with KeyStoreError when the key store is not available or denies access to its key. */
    readonly encrypt: (text: string) => Effect.Effect<Uint8Array, KeyStoreError>;
    /**
     * Decrypts what `encrypt` returned. Fails with KeyStoreError when the key
     * store is not available or denies access to its key, or when the key is
     * not the one the text was encrypted with.
     */
    readonly decrypt: (encrypted: Uint8Array) => Effect.Effect<string, KeyStoreError>;
  }
>()("hercule/desktop/SafeStorage") {}

/** Returns the KeyStoreError for `error`, which Electron's `safeStorage` threw. */
const toKeyStoreError = (error: unknown): KeyStoreError =>
  new KeyStoreError({ message: error instanceof Error ? error.message : String(error) });

/** The parts of Electron's `safeStorage` the SafeStorage layer uses. */
export type ElectronSafeStorageCalls = Pick<
  ElectronSafeStorage,
  | "encryptString"
  | "decryptString"
  | "isEncryptionAvailable"
  | "getSelectedStorageBackend"
  | "setUsePlainTextEncryption"
>;

/**
 * Builds the SafeStorage service on Electron's `safeStorage` for `platform`.
 * Use it only once the app is ready: on macOS, the first call reads the key
 * from the Keychain, and blocks main while it does.
 *
 * On Linux, every encryption and decryption first checks that a real keyring
 * is behind `safeStorage`; see `assertKeyringEncrypts` in `linux-key-store.ts`.
 *
 * `fixedKeyForTests` is true when an end-to-end test asked for the mock
 * Keychain. On Linux, it makes `safeStorage` encrypt with a fixed key, because
 * there is no keyring to start in a test. It is ignored on macOS, where
 * Chromium reads the same switch itself. Pass true only when the Node
 * inspector is open (see `requestsMockKeychain`): a token encrypted with a
 * fixed key is readable by any program.
 */
export const makeSafeStorageLayer = (
  safeStorage: ElectronSafeStorageCalls,
  platform: DesktopPlatform,
  fixedKeyForTests: boolean,
): Layer.Layer<SafeStorage> => {
  // The check is imported at the first use, because only Linux needs it and
  // nothing needs it before the token is read, which keeps it out of the file
  // main loads at launch.
  const checkKeyStore: Effect.Effect<void, KeyStoreError> =
    platform === "linux"
      ? Effect.promise(() => import("./linux-key-store")).pipe(
          Effect.flatMap((module) =>
            Effect.try({
              try: () => module.assertKeyringEncrypts(safeStorage, fixedKeyForTests),
              catch: toKeyStoreError,
            }),
          ),
        )
      : Effect.void;
  return Layer.succeed(SafeStorage)({
    keyStoreName: PLATFORM_BEHAVIOUR[platform].keyStoreName,
    encrypt: (text) =>
      Effect.andThen(
        checkKeyStore,
        Effect.try({ try: () => safeStorage.encryptString(text), catch: toKeyStoreError }),
      ),
    decrypt: (encrypted) =>
      Effect.andThen(
        checkKeyStore,
        Effect.try({
          try: () => safeStorage.decryptString(Buffer.from(encrypted)),
          catch: toKeyStoreError,
        }),
      ),
  });
};
