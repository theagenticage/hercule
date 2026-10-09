/**
 * The new machine's side of a promotion transfer: unpacks a transfer that
 * `hercule promote` saved to a file into an empty Hercule Home, creates this
 * machine's Master Key, and encrypts every secret again under that key.
 *
 * No controller boots here. Once this returns, the Home holds a database
 * whose secrets the Master Key opens, so the first boot never meets secrets
 * it cannot read.
 */
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HomePaths } from "@hercule/home";
import { buildAttachmentPath, buildAttachmentsDirectory } from "../attachments";
import { binaryVersion, openDatabaseCopy } from "../db";
import { createMasterKey, openKeyStore, rewrapSecrets, type MasterKeyBackend } from "../secrets";
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

/**
 * Returns the message of a thrown error. A thrown value that is not an
 * `Error` is converted to a string, so there is always something to show.
 */
export const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Checks that the Home at `paths` is empty enough to receive a transfer: no
 * database, no attachments directory, and no Master Key in the store
 * `backend` names. Fails with `PromotionReceiveError` naming what is there,
 * and writes nothing.
 */
export const refuseOccupiedHome = (
  paths: HomePaths,
  backend: MasterKeyBackend,
): Effect.Effect<void, PromotionReceiveError> =>
  Effect.gen(function* () {
    for (const path of [paths.databaseFile, buildAttachmentsDirectory(paths.dataDir)]) {
      if (existsSync(path)) {
        return yield* new PromotionReceiveError({
          message: `${path} already exists; promotion needs an empty Hercule Home`,
        });
      }
    }
    const store = openKeyStore(paths, backend);
    const existing = yield* store.read.pipe(
      Effect.mapError((error) => new PromotionReceiveError({ message: error.message })),
    );
    if (existing !== undefined) {
      existing.fill(0);
      return yield* new PromotionReceiveError({
        message: `${store.describe} already holds a master key; promotion needs an empty Hercule Home`,
      });
    }
  });

/** Removes the database and the attachments a transfer wrote into the Home at `paths`. */
const removeReceivedFiles = (paths: HomePaths): Effect.Effect<void> =>
  Effect.sync(() => {
    rmSync(paths.databaseFile, { force: true });
    rmSync(buildAttachmentsDirectory(paths.dataDir), { recursive: true, force: true });
  });

/**
 * Exclusively creates the destination database file and attachments
 * directory. Fails with `PromotionReceiveError` when either already exists,
 * without truncating them, and removes the database file it created when the
 * attachments directory cannot be reserved.
 */
const reserveDestination = (paths: HomePaths): Effect.Effect<void, PromotionReceiveError> =>
  Effect.try({
    try: () => {
      mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
      const fd = openSync(
        paths.databaseFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      closeSync(fd);
      try {
        mkdirSync(buildAttachmentsDirectory(paths.dataDir), { mode: 0o700 });
      } catch (cause) {
        rmSync(paths.databaseFile, { force: true });
        throw cause;
      }
    },
    catch: (cause) => {
      const err = cause as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        return new PromotionReceiveError({
          message: `${err.path ?? paths.databaseFile} already exists; promotion needs an empty Hercule Home`,
        });
      }
      return new PromotionReceiveError({
        message: `could not reserve the Home: ${readErrorMessage(cause)}`,
      });
    },
  });

/**
 * Removes everything a received transfer put in the Home at `paths`: the
 * database, the attachments, the promotion transfer directory and the Master
 * Key. Called when the switch fails after the transfer, so a retry starts
 * from an empty Home. A key that cannot be removed is logged, because the
 * retry then names it.
 */
export const discardReceivedHome = (
  paths: HomePaths,
  backend: MasterKeyBackend,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* removeReceivedFiles(paths);
    rmSync(paths.promotionTransferDir, { recursive: true, force: true });
    yield* openKeyStore(paths, backend).remove.pipe(
      Effect.catch((error) => Effect.logWarning("Could not remove the master key", error)),
    );
  });

/**
 * Copies the bytes `range` of the file at `from` into a new file at `to`,
 * readable by its owner only, without holding them in memory.
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
        createWriteStream(to, { mode: 0o600 }),
      ),
    catch: (cause) =>
      new PromotionReceiveError({ message: `could not write ${to}: ${readErrorMessage(cause)}` }),
  });

/**
 * Unpacks the transfer saved at `transferFile` into the Home at `paths`,
 * creates this machine's Master Key in the store `backend` names, and
 * encrypts every secret again from the key that `tokenBytes`, the decoded
 * promotion token, derives to that Master Key.
 *
 * Fails, having written nothing:
 *
 * - when the Home is not empty;
 * - when the transfer is not one this build can read;
 * - when the transfer comes from another controller than
 *   `previewedControllerId`, the one the preview showed the user;
 * - when the transfer's schema is newer than this build.
 *
 * Fails with `PromotionReceiveError` when a later step fails, after removing
 * what it wrote.
 *
 * `hercule promote` checks that the Home is empty before the transfer too,
 * so it can refuse before the token is spent. This function checks again,
 * then exclusively creates the destination database and attachments
 * directory, because a long transfer or a confirmation prompt left open
 * leaves time for something else to start in the same Home. An existing
 * file is refused; it is never truncated.
 */
export const receiveTransfer = (
  paths: HomePaths,
  tokenBytes: Uint8Array<ArrayBuffer>,
  previewedControllerId: string,
  transferFile: string,
  backend: MasterKeyBackend,
): Effect.Effect<ReceivedTransfer, PromotionReceiveError | TransferBundleError> =>
  Effect.gen(function* () {
    yield* refuseOccupiedHome(paths, backend);
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

    yield* reserveDestination(paths);

    let createdKey = false;
    const unpack = Effect.gen(function* () {
      yield* copyRange(transferFile, layout.database, paths.databaseFile);
      for (const attachment of layout.attachments) {
        yield* copyRange(
          transferFile,
          attachment,
          buildAttachmentPath(paths.dataDir, attachment.id),
        );
      }

      const masterKey = yield* createMasterKey(
        openKeyStore(paths, backend),
        Effect.sync(() => {
          createdKey = true;
        }),
      ).pipe(Effect.mapError((error) => new PromotionReceiveError({ message: error.message })));
      const transferKey = yield* deriveTransferKey(tokenBytes, salt);
      yield* rewrapSecrets(transferKey, masterKey).pipe(
        Effect.provide(openDatabaseCopy(paths.databaseFile)),
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
      return { controllerId: header.controllerId, schemaVersion: header.schemaVersion };
    });

    return yield* unpack.pipe(
      Effect.onError(() =>
        createdKey ? discardReceivedHome(paths, backend) : removeReceivedFiles(paths),
      ),
    );
  });
