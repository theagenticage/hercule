/**
 * Encryption with a key the macOS Keychain keeps, which main uses to store the
 * login token. Electron's `safeStorage` does the work; this service wraps it
 * so that the code which stores the token can be tested with a fake.
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

/**
 * The error encryption or decryption fails with: the Keychain denied access
 * to its key, or the data was encrypted with another key. `message` is
 * Electron's.
 */
export class KeychainError extends Data.TaggedError("KeychainError")<{
  readonly message: string;
}> {}

/** Encryption and decryption of text with the Keychain's key. */
export class SafeStorage extends Context.Service<
  SafeStorage,
  {
    /** Encrypts `text`. Fails with KeychainError when the Keychain denies access to its key. */
    readonly encrypt: (text: string) => Effect.Effect<Uint8Array, KeychainError>;
    /**
     * Decrypts what `encrypt` returned. Fails with KeychainError when the
     * Keychain denies access to its key, or when the key is not the one the
     * text was encrypted with.
     */
    readonly decrypt: (encrypted: Uint8Array) => Effect.Effect<string, KeychainError>;
  }
>()("hercule/desktop/SafeStorage") {}

/** Returns the KeychainError for `error`, which Electron's `safeStorage` threw. */
const toKeychainError = (error: unknown): KeychainError =>
  new KeychainError({ message: error instanceof Error ? error.message : String(error) });

/**
 * Builds the SafeStorage service on Electron's `safeStorage`. Use it only once
 * the app is ready: on macOS, the first call reads the key from the Keychain,
 * and blocks main while it does.
 */
export const makeSafeStorageLayer = (
  safeStorage: Pick<ElectronSafeStorage, "encryptString" | "decryptString">,
): Layer.Layer<SafeStorage> =>
  Layer.succeed(SafeStorage)({
    encrypt: (text) =>
      Effect.try({ try: () => safeStorage.encryptString(text), catch: toKeychainError }),
    decrypt: (encrypted) =>
      Effect.try({
        try: () => safeStorage.decryptString(Buffer.from(encrypted)),
        catch: toKeychainError,
      }),
  });
