/**
 * The Master Key: one 32-byte key per controller machine, created at first run
 * and used to encrypt every secret value in the controller database (spec 13
 * section 2.2, ADR 0015).
 *
 * Where it lives, by platform:
 *
 * - **macOS**: the login keychain, through the `security` CLI, as a generic
 *   password with service `Hydra` and the absolute Hydra Home path as the
 *   account, so two homes on one machine never collide. The controller runs as
 *   a user-level service precisely so it can read the login keychain without a
 *   prompt.
 * - **Everywhere else**: `<home>/master.key`, mode 0600, holding the key
 *   **base64-encoded with a trailing newline**. It sits at the Hydra Home root,
 *   outside `data/` and `backups/`, so promotion never moves it and backups
 *   stay inert.
 *
 * Spec 13 section 2.2 also names the Linux desktop keychain (Secret Service).
 * Hydra v1 does not implement it; the file is the only non-macOS store, and
 * that narrowing is recorded in the spec rather than left implicit.
 *
 * The key never reaches the database, a backup, a promotion bundle, a log line,
 * or an error message. It is held only as a non-extractable WebCrypto key, and
 * the bytes it was imported from are zeroed as soon as the import succeeds.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HydraHome } from "../config";

/** A master key is 32 bytes: AES-256 takes nothing else. */
export const MASTER_KEY_BYTES = 32;

/** The keychain service name every Hydra home on a machine shares. */
export const KEYCHAIN_SERVICE = "Hydra";

/**
 * The master key could not be read, created, or stored.
 *
 * Message-only, deliberately: the key and any command line carrying it must
 * never reach a log, so no cause, stdout, or argv is ever attached.
 */
export class MasterKeyError extends Schema.TaggedError<MasterKeyError>()("MasterKeyError", {
  message: Schema.String,
}) {}

/**
 * The Master Key, as the AES-256-GCM key the secrets repository encrypts with.
 * Non-extractable, so the raw bytes cannot be recovered from it.
 */
export class MasterKey extends Context.Service<
  MasterKey,
  {
    readonly key: CryptoKey;
  }
>()("hydra/controller/keys/MasterKey") {}

/** Plain bytes, not a view on a `SharedArrayBuffer`: what WebCrypto accepts. */
type Bytes = Uint8Array<ArrayBuffer>;

/** Where a master key is kept. Two implementations: the macOS keychain, and a file. */
interface KeyStore {
  /** The stored key, or `undefined` when this machine has none yet. */
  readonly read: Effect.Effect<Bytes | undefined, MasterKeyError>;
  readonly write: (bytes: Bytes) => Effect.Effect<void, MasterKeyError>;
}

const decodeBase64 = (encoded: string, source: string): Bytes => {
  const bytes = new Uint8Array(Buffer.from(encoded.trim(), "base64"));
  if (bytes.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `${source} holds ${bytes.length} bytes; a Hydra master key is ${MASTER_KEY_BYTES} bytes.`,
    );
  }
  return bytes;
};

const fileStore = (path: string): KeyStore => ({
  read: Effect.try({
    try: () => (existsSync(path) ? decodeBase64(readFileSync(path, "utf8"), path) : undefined),
    catch: (cause) => new MasterKeyError({ message: `Cannot read ${path}: ${String(cause)}` }),
  }),
  write: (bytes) =>
    Effect.try({
      try: () => {
        // The mode argument only applies when the file is created, so an
        // existing file is chmod-ed as well: 0600 is the whole protection.
        writeFileSync(path, `${Buffer.from(bytes).toString("base64")}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
      },
      // The cause here is a filesystem error and never carries the key, but the
      // key was an argument to the call that failed, so only the path is named.
      catch: () => new MasterKeyError({ message: `Cannot write the master key to ${path}.` }),
    }),
});

/** The `security` invocation that reads this home's key. Exit code 44 means "no such item". */
export const keychainReadCommand = (account: string): ReadonlyArray<string> => [
  "security",
  "find-generic-password",
  "-s",
  KEYCHAIN_SERVICE,
  "-a",
  account,
  "-w",
];

/**
 * The `security` invocation that stores this home's key. `-U` updates an
 * existing item instead of adding a duplicate.
 *
 * `security` has no way to take a password on stdin, so the key is on the
 * command line for the lifetime of the process, visible to `ps` for the same
 * OS user. Hydra's perimeter is one user's own machine (spec 13 section 1), and
 * this happens once, at first run.
 */
export const keychainWriteCommand = (account: string, encoded: string): ReadonlyArray<string> => [
  "security",
  "add-generic-password",
  "-s",
  KEYCHAIN_SERVICE,
  "-a",
  account,
  "-w",
  encoded,
  "-U",
];

/** `security` exits 44 when the item is not in the keychain. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;

const runSecurity = (
  command: ReadonlyArray<string>,
  failure: string,
): Effect.Effect<{ readonly exitCode: number; readonly stdout: string }, MasterKeyError> =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const stdout = await new Response(child.stdout).text();
      const exitCode = await child.exited;
      return { exitCode, stdout };
    },
    // No cause: it would carry the argv, and the write command's argv carries
    // the key. Same reason stderr is discarded and stdout never appears here -
    // `find-generic-password -w` prints the key on stdout.
    catch: () => new MasterKeyError({ message: failure }),
  });

const keychainStore = (account: string): KeyStore => ({
  read: Effect.gen(function* () {
    const result = yield* runSecurity(
      keychainReadCommand(account),
      "Cannot run `security` to read the master key from the login keychain.",
    );
    if (result.exitCode === KEYCHAIN_ITEM_NOT_FOUND) return undefined;
    if (result.exitCode !== 0) {
      return yield* new MasterKeyError({
        message:
          `Reading the master key from the login keychain failed: \`security\` exited ` +
          `${result.exitCode} for service ${KEYCHAIN_SERVICE}, account ${account}.`,
      });
    }
    return yield* Effect.try({
      try: () => decodeBase64(result.stdout, `The ${KEYCHAIN_SERVICE} keychain item`),
      catch: (cause) => new MasterKeyError({ message: String(cause) }),
    });
  }),
  write: (bytes) =>
    Effect.gen(function* () {
      const result = yield* runSecurity(
        keychainWriteCommand(account, Buffer.from(bytes).toString("base64")),
        "Cannot run `security` to store the master key in the login keychain.",
      );
      if (result.exitCode !== 0) {
        return yield* new MasterKeyError({
          message:
            `Storing the master key in the login keychain failed: \`security\` exited ` +
            `${result.exitCode} for service ${KEYCHAIN_SERVICE}, account ${account}.`,
        });
      }
    }),
});

/** Which store this platform uses when the caller does not say (spec 13 section 2.2). */
export type MasterKeyBackend = "keychain" | "file";

/** macOS keeps the key in the login keychain; every other platform in the file. */
export const defaultBackend: MasterKeyBackend = process.platform === "darwin" ? "keychain" : "file";

/**
 * Reads this machine's master key, minting and storing one on first run, and
 * provides it as a non-extractable AES-256-GCM key.
 *
 * The backend is explicit so a test drives the file store in a temporary home
 * without ever touching the developer's real keychain.
 */
export const masterKeyLayer = (
  backend: MasterKeyBackend = defaultBackend,
): Layer.Layer<MasterKey, MasterKeyError, HydraHome> =>
  Layer.effect(
    MasterKey,
    Effect.gen(function* () {
      const home = yield* HydraHome;
      const store =
        backend === "keychain" ? keychainStore(home.home) : fileStore(home.masterKeyFile);

      let bytes = yield* store.read;
      if (bytes === undefined) {
        bytes = crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES));
        yield* store.write(bytes);
      }

      const key = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
        catch: () => new MasterKeyError({ message: "The master key is not a usable AES-256 key." }),
      });
      // WebCrypto copied the material; this process keeps no plain copy.
      bytes.fill(0);

      return MasterKey.of({ key });
    }),
  );
