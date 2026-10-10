/**
 * The Master Key: one 32-byte key per controller machine, created at first run
 * and used to encrypt every secret value in the controller database (spec 13
 * section 2.2, ADR 0015).
 *
 * Where it lives, by platform:
 *
 * - **macOS**: the login keychain, through the `security` CLI, as a generic
 *   password with service `Hercule` and the absolute Hercule Home path as the
 *   account, so two homes on one machine never collide. The controller runs as
 *   a user-level service precisely so it can read the login keychain without a
 *   prompt.
 * - **Everywhere else**: `<home>/master.key`, mode 0600, holding the key
 *   **base64-encoded with a trailing newline**. It sits at the Hercule Home root,
 *   outside `data/` and `backups/`, so promotion never moves it and backups
 *   stay inert.
 *
 * Spec 13 section 2.2 also names the Linux desktop keychain (Secret Service).
 * Hercule v1 does not implement it; the file is the only non-macOS store, and
 * that narrowing is recorded in the spec rather than left implicit.
 *
 * A key is minted only when the store has none **and** the database holds no
 * encrypted secrets. A store that lost its key with rows still in the table is
 * a lost key, not a first run: minting there would replace readable ciphertext
 * with unreadable ciphertext, so the controller refuses to start instead. That
 * is the one reason this module knows about the database at all.
 *
 * The key never reaches the database, a backup, a promotion bundle, a log line,
 * or an error message. It is held only as a non-extractable WebCrypto key, and
 * the bytes it was imported from are zeroed as soon as the import succeeds.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { HerculeHome } from "../config";

/** A master key is 32 bytes: AES-256 takes nothing else. */
export const MASTER_KEY_BYTES = 32;

/** The keychain service name every Hercule home on a machine shares. */
export const KEYCHAIN_SERVICE = "Hercule";

/** `security` exits 44 when the item is not in the keychain. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;

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
>()("hercule/controller/secrets/MasterKey") {}

/** Plain bytes, not a view on a `SharedArrayBuffer`: what WebCrypto accepts. */
type Bytes = Uint8Array<ArrayBuffer>;

/** Where a master key is kept. Two implementations: the macOS keychain, and a file. */
export interface KeyStore {
  /** How error messages name the store. */
  readonly describe: string;
  /** The stored key, or `undefined` when this machine has none yet. */
  readonly read: Effect.Effect<Bytes | undefined, MasterKeyError>;
  /**
   * Stores a newly minted key, and returns the key the store now holds.
   *
   * Reading and minting are two steps, so two first boots of the same home can
   * both find the store empty and both mint. The store, not the caller, settles
   * that: whichever write lands first wins, and the loser is handed the winner's
   * key rather than overwriting it. A key that replaced another one would leave
   * every secret already encrypted under the first unreadable.
   */
  readonly write: (bytes: Bytes) => Effect.Effect<Bytes, MasterKeyError>;
  /** Removes the stored key. Succeeds when there is none. */
  readonly remove: Effect.Effect<void, MasterKeyError>;
}

const decodeBase64 = (encoded: string, source: string): Bytes => {
  const bytes = new Uint8Array(Buffer.from(encoded.trim(), "base64"));
  if (bytes.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `${source} holds ${bytes.length} bytes; a Hercule master key is ${MASTER_KEY_BYTES} bytes.`,
    );
  }
  return bytes;
};

/**
 * Returns the store backed by the key file, mode 0600. The file mode is the
 * key's only protection, so each read checks it.
 */
export const createFileStore = (path: string): KeyStore => {
  const read: Effect.Effect<Bytes | undefined, MasterKeyError> = Effect.try({
    try: () => {
      if (!existsSync(path)) return undefined;
      const mode = statSync(path).mode & 0o777;
      if (mode !== 0o600) {
        throw new Error(
          `${path} is mode ${mode.toString(8).padStart(4, "0")}, not 0600: the file mode is the only ` +
            `thing protecting the master key. Run chmod 600 on it.`,
        );
      }
      return decodeBase64(readFileSync(path, "utf8"), path);
    },
    catch: (cause) =>
      new MasterKeyError({
        message: `Cannot use the master key: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

  /** Reads the key another process wrote between this process's read and its write. */
  const readAfterRace = Effect.flatMap(read, (bytes) =>
    bytes === undefined
      ? new MasterKeyError({
          message: `${path} appeared while Hercule was creating it, and then held no master key.`,
        })
      : Effect.succeed(bytes),
  );

  return {
    describe: path,
    read,
    write: (bytes) =>
      Effect.try({
        // `wx` creates the file or fails; it never truncates one. That is what
        // makes the mint atomic between two boots, and `mode` applies only when
        // the file is created, so the key is never briefly world-readable.
        try: () => {
          writeFileSync(path, `${Buffer.from(bytes).toString("base64")}\n`, {
            mode: 0o600,
            flag: "wx",
          });
          return bytes;
        },
        // The cause here is a filesystem error and never carries the key, but the
        // key was an argument to the call that failed, so only the path is named.
        catch: (cause) => cause as NodeJS.ErrnoException,
      }).pipe(
        Effect.catch((cause) =>
          cause.code === "EEXIST"
            ? readAfterRace
            : Effect.fail(
                new MasterKeyError({ message: `Cannot write the master key to ${path}.` }),
              ),
        ),
      ),
    remove: Effect.try({
      try: () => rmSync(path, { force: true }),
      catch: () => new MasterKeyError({ message: `Cannot remove the master key file ${path}.` }),
    }),
  };
};

/** What one run of `security` returned. */
export interface SecurityResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `security` and returns its exit code and output. Injected, so tests drive every branch. */
export type SecurityRunner = (argv: ReadonlyArray<string>) => Promise<SecurityResult>;

/**
 * Returns the end of a failure message: how `security` exited and, when it
 * printed an error, that error on one line. `security` prints the reason on
 * stderr, such as a locked keychain or a session with no access to it, and
 * without the reason the failure cannot be explained.
 *
 * Only stderr is quoted. `find-generic-password -w` prints the key on stdout,
 * and `security` never repeats its arguments on stderr.
 */
const describeSecurityExit = (result: SecurityResult, item: string): string => {
  const printed = result.stderr.trim().replace(/\s*\n\s*/g, " ");
  const exit = `\`security\` exited ${String(result.exitCode)} for ${item}.`;
  return printed === "" ? exit : `${exit} It printed: ${printed}`;
};

/**
 * Runs the real macOS `security` CLI.
 *
 * There is no way to hand it a password on stdin, so the key is on the command
 * line for the lifetime of the process, visible to `ps` for the same OS user.
 * Hercule's perimeter is one user's own machine (spec 13 section 1), and this
 * happens once, at first run.
 */
export const spawnSecurity: SecurityRunner = async (argv) => {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
};

/** The macOS login keychain, one item per Hercule Home. */
export const createKeychainStore = (
  account: string,
  run: SecurityRunner = spawnSecurity,
): KeyStore => {
  const item = `the ${KEYCHAIN_SERVICE} keychain item for account ${account}`;
  const runSecurity = (argv: ReadonlyArray<string>, failure: string) =>
    Effect.tryPromise({
      try: () => run(argv),
      // No cause: it would carry the argv, and the write command's argv carries
      // the key.
      catch: () => new MasterKeyError({ message: failure }),
    });

  const read: Effect.Effect<Bytes | undefined, MasterKeyError> = Effect.gen(function* () {
    const result = yield* runSecurity(
      ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      "Cannot run `security` to read the master key from the login keychain.",
    );
    if (result.exitCode === KEYCHAIN_ITEM_NOT_FOUND) return undefined;
    if (result.exitCode !== 0) {
      return yield* new MasterKeyError({
        message: `Reading the master key from the login keychain failed: ${describeSecurityExit(result, item)}`,
      });
    }
    return yield* Effect.try({
      try: () => decodeBase64(result.stdout, item),
      catch: (cause) => new MasterKeyError({ message: String(cause) }),
    });
  });

  return {
    describe: item,
    read,
    // No `-U`: without it, `add-generic-password` fails for an item that
    // already exists rather than replacing it, which makes the mint atomic
    // between two boots. On any failure, the item another boot stored is read
    // back; only a keychain that still has no item is a real failure.
    write: (bytes) =>
      Effect.gen(function* () {
        // An interrupt waits for `security` to exit. Otherwise the command
        // keeps running after the interrupt, and can store the key after a
        // cleanup has already removed it, leaving a key nobody knows about.
        const result = yield* Effect.uninterruptible(
          runSecurity(
            [
              "security",
              "add-generic-password",
              "-s",
              KEYCHAIN_SERVICE,
              "-a",
              account,
              "-w",
              Buffer.from(bytes).toString("base64"),
            ],
            "Cannot run `security` to store the master key in the login keychain.",
          ),
        );
        if (result.exitCode === 0) return bytes;
        const stored = yield* read;
        if (stored !== undefined) return stored;
        return yield* new MasterKeyError({
          message: `Storing the master key in the login keychain failed: ${describeSecurityExit(result, item)}`,
        });
      }),
    remove: Effect.gen(function* () {
      const result = yield* runSecurity(
        ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
        "Cannot run `security` to remove the master key from the login keychain.",
      );
      if (result.exitCode === 0 || result.exitCode === KEYCHAIN_ITEM_NOT_FOUND) return;
      return yield* new MasterKeyError({
        message: `Removing the master key from the login keychain failed: ${describeSecurityExit(result, item)}`,
      });
    }),
  };
};

/** Which store this platform uses when the caller does not say (spec 13 section 2.2). */
export type MasterKeyBackend = "keychain" | "file";

/** macOS keeps the key in the login keychain; every other platform in the file. */
export const defaultBackend: MasterKeyBackend = process.platform === "darwin" ? "keychain" : "file";

/**
 * Returns the store that holds the master key of the Hercule Home at `home`:
 * the login keychain item for that Home, or its key file.
 */
export const openKeyStore = (
  home: { readonly home: string; readonly masterKeyFile: string },
  backend: MasterKeyBackend,
  run: SecurityRunner = spawnSecurity,
): KeyStore =>
  backend === "keychain"
    ? createKeychainStore(home.home, run)
    : createFileStore(home.masterKeyFile);

/**
 * Imports key bytes as a non-extractable AES-256-GCM key, then zeroes the
 * bytes. Fails with `MasterKeyError` when they are not a usable key.
 */
const importMasterKey = (bytes: Bytes): Effect.Effect<CryptoKey, MasterKeyError> =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    catch: () => new MasterKeyError({ message: "The master key is not a usable AES-256 key." }),
  }).pipe(
    // WebCrypto copied the material; this process keeps no plain copy.
    Effect.ensuring(Effect.sync(() => bytes.fill(0))),
  );

/**
 * Mints a master key into an empty store and returns it, ready to encrypt.
 * Fails with `MasterKeyError` when the store already holds a key. Used where
 * secrets already exist under another key and are about to be re-encrypted
 * under this one, which `masterKeyLayer` refuses to mint for.
 */
export const createMasterKey = (store: KeyStore): Effect.Effect<CryptoKey, MasterKeyError> =>
  Effect.gen(function* () {
    const existing = yield* store.read;
    if (existing !== undefined) {
      existing.fill(0);
      return yield* new MasterKeyError({
        message: `${store.describe} already holds a master key.`,
      });
    }
    const stored = yield* store.write(crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES)));
    return yield* importMasterKey(stored);
  });

/** Counts the secrets in the database. Returns 0 before the first migration has run. */
const secretCount: Effect.Effect<number, SqlError, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'secrets'`;
  if (tables.length === 0) return 0;
  const rows = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM secrets`;
  return rows[0]?.n ?? 0;
});

/**
 * Reads this machine's master key, minting and storing one on first run, and
 * provides it as a non-extractable AES-256-GCM key.
 *
 * The backend is explicit so a test drives the file store in a temporary home
 * without ever touching the developer's real keychain. `run` is the `security`
 * CLI the keychain store uses; tests pass a fake so Linux CI can cover a
 * macOS-to-Linux promotion.
 */
export const masterKeyLayer = (
  backend: MasterKeyBackend = defaultBackend,
  run: SecurityRunner = spawnSecurity,
): Layer.Layer<MasterKey, MasterKeyError | SqlError, HerculeHome | SqlClient.SqlClient> =>
  Layer.effect(
    MasterKey,
    Effect.gen(function* () {
      const home = yield* HerculeHome;
      const store = openKeyStore(home, backend, run);

      let bytes = yield* store.read;
      if (bytes === undefined) {
        const secrets = yield* secretCount;
        if (secrets > 0) {
          return yield* new MasterKeyError({
            message:
              `${store.describe} holds no master key, but ${home.databaseFile} holds ${secrets} ` +
              `encrypted secret ${secrets === 1 ? "row" : "rows"}. Minting a new key would make ` +
              `${secrets === 1 ? "it" : "them"} unreadable. ` +
              `Restore the key this machine had, or start from an empty Hercule Home.`,
          });
        }
        // The store returns the key it holds, which is another boot's key if
        // that boot minted first; the key minted here is then never used.
        bytes = yield* store.write(crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES)));
      }

      return MasterKey.of({ key: yield* importMasterKey(bytes) });
    }),
  );
