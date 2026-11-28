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
  /**
   * True when the key store could not be used at all this time, such as a
   * keyring that is not running or is locked: the key is not known to have
   * changed, and the same data may decrypt at the next launch. False when the
   * key store answered and refused, or the data does not decrypt with its key.
   */
  readonly unavailable: boolean;
  /** A sentence that tells the user what to do about it, or null when there is none. */
  readonly advice: string | null;
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
  new KeyStoreError({
    message: error instanceof Error ? error.message : String(error),
    unavailable: false,
    advice: null,
  });

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
 * is behind `safeStorage`; see `findKeyringProblem` in `linux-key-store.ts`.
 */
export const makeSafeStorageLayer = (
  safeStorage: ElectronSafeStorageCalls,
  platform: DesktopPlatform,
): Layer.Layer<SafeStorage> => {
  // The check is imported at the first use, because only Linux needs it and
  // nothing needs it before the token is read, which keeps it out of the file
  // main loads at launch.
  const checkKeyStore: Effect.Effect<void, KeyStoreError> =
    platform === "linux"
      ? Effect.promise(() => import("./linux-key-store")).pipe(
          Effect.flatMap((module) =>
            Effect.try({
              try: () => module.findKeyringProblem(safeStorage),
              catch: toKeyStoreError,
            }),
          ),
          Effect.flatMap((problem) =>
            problem === undefined
              ? Effect.void
              : Effect.fail(new KeyStoreError({ ...problem, unavailable: true })),
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
