/**
 * The new machine's side of a promotion transfer: reserves an empty Hercule
 * Home, unpacks a transfer that `hercule promote` saved to a file into it,
 * creates this machine's Master Key, and encrypts every secret again under
 * that key.
 *
 * No controller boots here. Once the transfer is received, the Home holds a
 * database whose secrets the Master Key opens, so the first boot never meets
 * secrets it cannot read.
 *
 * The Home is reserved with the controller lock: the exclusive SQLite lock a
 * controller holds on its database. While the reservation lasts, a controller
 * started in this Home fails to open its database, so the promotion never
 * writes over a controller's data, and never deletes it when it cleans up.
 */
import {
  createReadStream,
  createWriteStream,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { HomePaths } from "@hercule/home";
import { buildAttachmentPath, buildAttachmentsDirectory } from "../attachments";
import { binaryVersion, openDatabase, openDatabaseCopy } from "../db";
import {
  createMasterKey,
  openKeyStore,
  rewrapSecrets,
  type MasterKeyBackend,
  type SecurityRunner,
} from "../secrets";
import { readTransferLayout, type ByteRange, type TransferBundleError } from "./bundle";
import { decodeBase64Url, deriveTransferKey, SALT_BYTES } from "./crypto";

/** A promotion transfer the new machine refused or could not apply. */
export class PromotionReceiveError extends Schema.TaggedError<PromotionReceiveError>()(
  "PromotionReceiveError",
  { message: Schema.String },
) {}

/** What a received transfer was: which controller, at which schema version. */
export interface ReceivedTransfer {
  readonly controllerId: string;
  readonly schemaVersion: number;
}

/** An empty Hercule Home that this process has reserved for a promotion transfer. */
export interface ReservedHome {
  readonly paths: HomePaths;
  readonly keyStore: ReturnType<typeof openKeyStore>;
  /**
   * The directory this promotion keeps its own files in until it ends: the
   * placeholder database, the saved transfer and the unpacked database.
   */
  readonly transferDirectory: string;
  /**
   * The scope that holds the controller locks. It closes after everything
   * else the reservation registered, so every file is removed while the Home
   * is still locked.
   */
  readonly locks: Scope.Scope;
}

/**
 * Returns the message of a thrown error. A thrown value that is not an
 * `Error` is converted to a string, so there is always something to show.
 */
export const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Returns the error for a file or directory at `path` that could not be
 * created. Something already at `path` means the Home is not empty.
 */
const describeCreateFailure = (path: string, cause: unknown): PromotionReceiveError =>
  new PromotionReceiveError({
    message:
      (cause as NodeJS.ErrnoException).code === "EEXIST"
        ? `${path} already exists; promotion needs an empty Hercule Home`
        : `could not create ${path}: ${readErrorMessage(cause)}`,
  });

/** Creates a directory at `path`, readable by its owner only. Fails when anything is already there. */
const createDirectoryExclusively = (path: string): Effect.Effect<void, PromotionReceiveError> =>
  Effect.try({
    try: () => mkdirSync(path, { mode: 0o700 }),
    catch: (cause) => describeCreateFailure(path, cause),
  });

/**
 * Reserves the Hercule Home at `paths` for a promotion transfer, and fails
 * with `PromotionReceiveError` when the Home is not empty: when it holds a
 * database, an attachments directory, or a Master Key in the store that
 * `backend` names. `run` is the `security` CLI the Keychain store uses; tests
 * pass a fake.
 *
 * The reservation lasts until the scope closes. When the scope closes with a
 * failure, everything the reservation and `receiveTransfer` created is
 * removed. When it closes with a success, the received data stays. Either
 * way, this promotion's own directory inside the promotion transfer
 * directory is removed, and the controller lock is released last, so a
 * controller can start in this Home only afterwards.
 *
 * The lock is taken before anything is checked. The database name is claimed
 * by hard-linking a locked placeholder database to it: a link fails when the
 * name exists, so the check and the claim are one step, and from the moment
 * the name exists, a controller that opens it finds it locked. The claim is
 * the only check that another promotion or a controller holds the Home.
 */
export const reserveHome = (
  paths: HomePaths,
  backend: MasterKeyBackend,
  run?: SecurityRunner,
): Effect.Effect<ReservedHome, PromotionReceiveError, Scope.Scope> =>
  Effect.gen(function* () {
    // Forked first, so the locks are released after every removal below.
    const locks = yield* Scope.fork(yield* Effect.scope, "sequential");

    yield* Effect.acquireRelease(
      Effect.try({
        try: () => mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 }),
        catch: (cause) => describeCreateFailure(paths.dataDir, cause),
      }),
      // `mkdirSync` returns the first directory it created, if any. Only the
      // directories created here are removed, and only when they are empty.
      (firstCreated, exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit) || firstCreated === undefined) return;
          for (let directory = paths.dataDir; ; directory = dirname(directory)) {
            try {
              rmdirSync(directory);
            } catch {
              return;
            }
            if (directory === firstCreated) return;
          }
        }),
    );

    // The promotion transfer directory may already hold another transfer's
    // files, which are not this promotion's to check or remove. So it is
    // removed only when this promotion created it and it is empty again.
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => mkdirSync(paths.promotionTransferDir, { recursive: true, mode: 0o700 }),
        catch: (cause) => describeCreateFailure(paths.promotionTransferDir, cause),
      }),
      (created) =>
        Effect.sync(() => {
          if (created === undefined) return;
          try {
            rmdirSync(paths.promotionTransferDir);
          } catch {
            // Not empty: another transfer's files are in it.
          }
        }),
    );
    // A directory of its own, like the one the old controller copies its data into.
    const transferDirectory = yield* Effect.acquireRelease(
      Effect.try({
        try: () => mkdtempSync(join(paths.promotionTransferDir, "incoming-")),
        catch: (cause) => describeCreateFailure(paths.promotionTransferDir, cause),
      }),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );

    const placeholder = join(transferDirectory, "reservation.db");
    yield* Layer.buildWithScope(openDatabase(placeholder), locks).pipe(
      Effect.mapError((error) => new PromotionReceiveError({ message: error.message })),
    );
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => linkSync(placeholder, paths.databaseFile),
        catch: (cause) => describeCreateFailure(paths.databaseFile, cause),
      }),
      (_, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.sync(() => rmSync(paths.databaseFile, { force: true })),
    );

    const attachmentsDirectory = buildAttachmentsDirectory(paths.dataDir);
    yield* Effect.acquireRelease(createDirectoryExclusively(attachmentsDirectory), (_, exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.sync(() => rmSync(attachmentsDirectory, { recursive: true, force: true })),
    );

    const keyStore = openKeyStore(paths, backend, run);
    const existing = yield* keyStore.read.pipe(
      Effect.mapError((error) => new PromotionReceiveError({ message: error.message })),
    );
    if (existing !== undefined) {
      existing.fill(0);
      return yield* new PromotionReceiveError({
        message: `${keyStore.describe} already holds a master key; promotion needs an empty Hercule Home`,
      });
    }
    return { paths, keyStore, transferDirectory, locks };
  });

/**
 * Copies the bytes `range` of the file at `from` into a new file at `to`,
 * readable by its owner only, without holding them in memory. Fails when a
 * file already exists at `to`.
 */
const copyRange = (from: string, range: ByteRange, to: string) =>
  Effect.tryPromise({
    // Not `Bun.write(to, Bun.file(from).slice(...))`: on macOS Bun 1.4 copies
    // the whole file and ignores the slice.
    // An empty range still makes a file; `createReadStream` refuses an end before its start.
    try: () =>
      pipeline(
        range.end === range.start
          ? Readable.from([])
          : createReadStream(from, { start: range.start, end: range.end - 1 }),
        createWriteStream(to, { flags: "wx", mode: 0o600 }),
      ),
    catch: (cause) =>
      new PromotionReceiveError({ message: `could not write ${to}: ${readErrorMessage(cause)}` }),
  });

/**
 * Unpacks the transfer saved at `transferFile` into the reserved Home `home`,
 * creates this machine's Master Key in its store, and encrypts every secret
 * again from the key that `tokenBytes`, the decoded promotion token, derives
 * to that Master Key. Runs in the scope of the reservation, so a failure
 * removes what it created when that scope closes.
 *
 * Fails with `TransferBundleError` when the transfer is not one this build
 * can read, and with `PromotionReceiveError`:
 *
 * - when the transfer comes from another controller than
 *   `previewedControllerId`, the one the preview showed the user;
 * - when the transfer's schema is newer than this build;
 * - when the secrets do not decrypt with the token, or a write fails.
 */
export const receiveTransfer = (
  home: ReservedHome,
  tokenBytes: Uint8Array<ArrayBuffer>,
  previewedControllerId: string,
  transferFile: string,
): Effect.Effect<ReceivedTransfer, PromotionReceiveError | TransferBundleError, Scope.Scope> =>
  Effect.gen(function* () {
    const { paths, keyStore, transferDirectory, locks } = home;
    const layout = yield* readTransferLayout(transferFile);
    const { header } = layout;
    // The preview and the transfer are two requests, and something between
    // the machines, such as a load balancer or a changed DNS record, can send
    // them to different controllers. The user confirmed the previewed one.
    if (header.controllerId !== previewedControllerId) {
      return yield* new PromotionReceiveError({
        message:
          `The transfer came from controller ${header.controllerId}, but the preview showed ` +
          `controller ${previewedControllerId}, so another controller answered at the same URL. ` +
          `Check that --from reaches only the controller you mean to promote`,
      });
    }
    if (header.schemaVersion > binaryVersion) {
      return yield* new PromotionReceiveError({
        message:
          `This machine's Hercule is too old for the controller it is pulling from ` +
          `(schema ${String(header.schemaVersion)}; this build knows ${String(binaryVersion)}). ` +
          `Update Hercule on this machine to at least the old controller's version.`,
      });
    }
    const salt = decodeBase64Url(header.salt);
    if (salt.byteLength !== SALT_BYTES) {
      return yield* new PromotionReceiveError({
        message: "the promotion transfer's salt is not 32 bytes",
      });
    }

    // The database is unpacked beside the placeholder, and takes the
    // database's name only once it is ready and locked.
    const database = join(transferDirectory, "received.db");
    yield* copyRange(transferFile, layout.database, database);
    for (const attachment of layout.attachments) {
      yield* copyRange(transferFile, attachment, buildAttachmentPath(paths.dataDir, attachment.id));
    }

    // The reservation found the key store empty, and holds the controller
    // lock, which a controller takes before it creates a key. So any key in
    // the store when the scope fails is the one created here. The removal is
    // registered before the key is created, so an interrupt at any point
    // during the creation still removes it.
    yield* Effect.addFinalizer((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : keyStore.remove.pipe(
            Effect.catch((error) => Effect.logWarning("Could not remove the master key", error)),
          ),
    );
    const masterKey = yield* createMasterKey(keyStore).pipe(
      Effect.mapError((error) => new PromotionReceiveError({ message: error.message })),
    );
    const transferKey = yield* deriveTransferKey(tokenBytes, salt);
    yield* rewrapSecrets(transferKey, masterKey).pipe(
      Effect.provide(openDatabaseCopy(database)),
      Effect.catchTag("SecretDecryptError", () =>
        Effect.fail(
          new PromotionReceiveError({
            message:
              "the secrets in the promotion transfer do not decrypt with this token, so the " +
              "transfer was not made for it",
          }),
        ),
      ),
      Effect.catchTags({
        SqlError: (error) => Effect.fail(new PromotionReceiveError({ message: error.message })),
        DatabaseError: (error) =>
          Effect.fail(new PromotionReceiveError({ message: error.message })),
      }),
    );

    // Locked before it is renamed, so no controller can open it under the
    // database's name before the reservation ends.
    yield* Layer.buildWithScope(openDatabase(database), locks).pipe(
      Effect.mapError((error) => new PromotionReceiveError({ message: error.message })),
    );
    // Its write-ahead log keeps its old name and is removed with this
    // promotion's directory, so the rename loses nothing only while that log is
    // empty. Opening the database writes nothing to it today; this check
    // fails loudly if that ever changes. `statSync` opens no file, so the
    // lock stays.
    const writeAheadLog = statSync(`${database}-wal`, { throwIfNoEntry: false });
    if (writeAheadLog !== undefined && writeAheadLog.size > 0) {
      return yield* new PromotionReceiveError({
        message: `the received database has unsaved changes in ${database}-wal, so it cannot be moved to ${paths.databaseFile}`,
      });
    }
    yield* Effect.try({
      try: () => renameSync(database, paths.databaseFile),
      catch: (cause) =>
        new PromotionReceiveError({
          message: `could not move the received database to ${paths.databaseFile}: ${readErrorMessage(cause)}`,
        }),
    });
    return { controllerId: header.controllerId, schemaVersion: header.schemaVersion };
  });
