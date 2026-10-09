/**
 * The old controller's side of a promotion transfer (spec 03 section 8.2).
 *
 * A machine holding a promotion token previews what it would take over, then
 * pulls a copy of the data, and can cancel the pull before it switches:
 *
 * - The preview changes nothing. This service only checks that the token may
 *   preview; the controller daemon builds the preview, because it lists the
 *   runners.
 * - The transfer spends the token, freezes this controller, copies the
 *   database with `VACUUM INTO` and encrypts every secret in the copy under
 *   the transfer key. It then streams the copy and the attachment files.
 * - A cancel ends the freeze, so this controller serves again at once rather
 *   than at the token's expiry.
 *
 * The live database and the Master Key never change. The copy is written to a
 * new directory in the Data Root's promotion transfer directory, on the same
 * disk as the database, and removed when the stream ends, or at the next start
 * when the controller stopped first. Nothing else picks
 * it up: a backup copies only the live database, and the transfer carries
 * only the database and the files of attachment rows.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createInvalidStateError,
  createUnauthenticatedError,
  type ControllerSealed,
  type InvalidState,
  type PromotionInProgress,
  type Unauthenticated,
} from "@hercule/contract";
import { buildAttachmentPath } from "../attachments";
import { SYSTEM_ACTOR } from "../actor";
import { HerculeHome } from "../config";
import {
  copyDatabaseTo,
  databaseVersion,
  nowIso,
  openDatabaseCopy,
  uuidToString,
  withTransaction,
  type DatabaseError,
} from "../db";
import { AuditLog } from "../events";
import { ControllerIdentity } from "../identity";
import { MasterKey, rewrapSecrets, type SecretDecryptError } from "../secrets";
import {
  streamTransfer,
  TRANSFER_FORMAT_VERSION,
  type TransferBundleError,
  type TransferHeader,
} from "./bundle";
import { decodePromotionToken, deriveTransferKey, encodeBase64Url, SALT_BYTES } from "./crypto";
import { PromotionExpiry } from "./expiry";
import { PromotionState } from "./state";
import { PromotionTokens } from "./tokens";

/**
 * The message does not say which case applies (never created, already used, or
 * expired). The caller has to do the same thing in every case, and telling
 * them apart would help someone probing for valid tokens.
 */
export const NO_PROMOTION_TOKEN =
  "that promotion token is not valid: it was never created, was already used, or has expired. " +
  "Create a new promotion token and try again";

const make = Effect.gen(function* () {
  const tokens = yield* PromotionTokens;
  const promotion = yield* PromotionState;
  const expiry = yield* PromotionExpiry;
  const audit = yield* AuditLog;
  const identity = yield* ControllerIdentity;
  const { dataDir, promotionTransferDir } = yield* HerculeHome;
  const masterKey = yield* MasterKey;
  const sql = yield* SqlClient.SqlClient;

  // A controller stopped in the middle of a transfer leaves its copy behind.
  // No transfer runs before this service exists, so whatever is there now is
  // such a leftover.
  yield* Effect.sync(() => rmSync(promotionTransferDir, { recursive: true, force: true }));

  /**
   * Copies the database into a new directory inside `promotionTransferDir`,
   * encrypts every secret in the copy under `transferKey`, and returns the
   * stream of the transfer. The stream removes the directory when it ends,
   * however it ends.
   */
  const buildTransfer = (transferKey: CryptoKey, salt: Uint8Array) =>
    Effect.gen(function* () {
      // Each transfer gets a directory of its own. A cancel or the token's
      // expiry ends the freeze while the stream may still be sending, so a
      // second transfer can start before the first one's copy is removed.
      mkdirSync(promotionTransferDir, { recursive: true, mode: 0o700 });
      const scratch = mkdtempSync(join(promotionTransferDir, "outgoing-"));
      const removeScratch = Effect.sync(() => rmSync(scratch, { recursive: true, force: true }));
      return yield* Effect.gen(function* () {
        const copyPath = join(scratch, "database.db");
        yield* copyDatabaseTo(copyPath).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        const copy = yield* Effect.gen(function* () {
          yield* rewrapSecrets(masterKey.key, transferKey);
          const copySql = yield* SqlClient.SqlClient;
          const attachments = yield* copySql<{
            readonly id: Uint8Array;
          }>`SELECT id FROM attachments ORDER BY id`;
          return {
            schemaVersion: yield* databaseVersion,
            attachmentIds: attachments.map((row) => uuidToString(row.id)),
          };
        }).pipe(Effect.provide(openDatabaseCopy(copyPath)));

        const attachmentFiles = copy.attachmentIds.map((id) => ({
          id,
          path: buildAttachmentPath(dataDir, id),
        }));
        // A missing file would fail the stream halfway, after the new machine
        // has started writing; refusing here names every missing file at once.
        const missing = attachmentFiles.filter(({ path }) => !existsSync(path));
        if (missing.length > 0) {
          return yield* createInvalidStateError(
            `The data directory has lost the files of ${String(missing.length)} attachment(s), ` +
              `so the data cannot be transferred whole: ${missing.map(({ path }) => path).join(", ")}. ` +
              `Restore them from a backup, and try again with a new promotion token.`,
          );
        }
        const attachments = attachmentFiles.map(({ id, path }) => ({
          id,
          path,
          byteLength: statSync(path).size,
        }));
        const header: TransferHeader = {
          formatVersion: TRANSFER_FORMAT_VERSION,
          controllerId: (yield* identity.readOrDie).id,
          schemaVersion: copy.schemaVersion,
          salt: encodeBase64Url(salt),
          databaseByteLength: statSync(copyPath).size,
          attachments: attachments.map(({ id, byteLength }) => ({ id, byteLength })),
        };
        return streamTransfer(
          header,
          copyPath,
          attachments.map((attachment) => attachment.path),
        ).pipe(Stream.ensuring(removeScratch));
      }).pipe(Effect.onError(() => removeScratch));
    });

  return {
    /**
     * Checks that `token` may preview a transfer: the token is live and this
     * controller is serving. Changes nothing, and does not spend the token.
     * Fails with `PromotionInProgress` or `ControllerSealed` when a transfer
     * would be refused anyway, and with `Unauthenticated` when the token
     * cannot be spent.
     *
     * The preview itself is built in the controller daemon, because it lists
     * the runners, and the runners domain sits above this one.
     */
    authorizePreview: (
      token: string,
    ): Effect.Effect<void, Unauthenticated | PromotionInProgress | ControllerSealed | SqlError> =>
      Effect.gen(function* () {
        yield* promotion.refuseTransferUnlessServing;
        const live = yield* tokens.lookupLive(token, yield* nowIso);
        if (Option.isNone(live)) return yield* createUnauthenticatedError(NO_PROMOTION_TOKEN);
      }),

    /**
     * Spends the token, freezes this controller, and returns the stream of the
     * transfer. Fails with `Unauthenticated` when the token cannot be spent,
     * and with the freeze's errors when the controller is not serving or
     * stays busy for too long. The token is spent before the freeze, so it is
     * used up even when the freeze is refused (spec 03 section 8.2).
     *
     * The freeze ends when anything fails before the stream finishes, including
     * a caller that hangs up. A stream that finishes leaves the controller
     * frozen until the switch, a cancel, or the token's expiry.
     */
    open: (
      token: string,
    ): Effect.Effect<
      Stream.Stream<Uint8Array, TransferBundleError>,
      | Unauthenticated
      | PromotionInProgress
      | ControllerSealed
      | InvalidState
      | SqlError
      | DatabaseError
      | SecretDecryptError
    > =>
      Effect.gen(function* () {
        const tokenBytes = decodePromotionToken(token);
        if (tokenBytes === undefined) return yield* createUnauthenticatedError(NO_PROMOTION_TOKEN);
        // The entry is written before the copy is taken, so it travels with
        // the data and the new machine's log shows where its data came from.
        const spent = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const spent = yield* tokens.spend(token, at);
            if (Option.isSome(spent)) {
              yield* audit.append({
                kind: "controller.promotion.started",
                actor: SYSTEM_ACTOR,
                payload: { promotionTokenId: spent.value.id },
                at,
              });
            }
            return spent;
          }),
        );
        if (Option.isNone(spent)) return yield* createUnauthenticatedError(NO_PROMOTION_TOKEN);
        const { id: tokenId, expiresAt } = spent.value;

        const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        // The thaw also covers a caller that hangs up while the freeze waits
        // for running work; a thaw of a freeze this token does not hold does nothing.
        // A thaw fails only once sealed, when the data has moved and the
        // freeze no longer matters.
        const thaw = Effect.ignore(promotion.thaw(tokenId));
        const transfer = yield* promotion.freeze(tokenId).pipe(
          Effect.andThen(expiry.scheduleThaw(tokenId, new Date(expiresAt))),
          Effect.andThen(deriveTransferKey(tokenBytes, salt)),
          Effect.flatMap((transferKey) => buildTransfer(transferKey, salt)),
          Effect.onError(() => thaw),
        );
        return transfer.pipe(Stream.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : thaw)));
      }),

    /**
     * Ends the freeze of the transfer the spent `token` paid for, so this
     * controller serves again. Does nothing when that freeze has already
     * ended. Fails with `Unauthenticated` when the token was never spent, and
     * with `ControllerSealed` once the switch has sealed this controller,
     * because the data has moved and a cancel can no longer undo that. The
     * new machine relies on that refusal to learn that a switch whose answer
     * it lost went through.
     */
    cancel: (token: string): Effect.Effect<void, Unauthenticated | ControllerSealed | SqlError> =>
      Effect.gen(function* () {
        const tokenId = yield* tokens.lookupSpent(token);
        if (Option.isNone(tokenId)) return yield* createUnauthenticatedError(NO_PROMOTION_TOKEN);
        const ended = yield* promotion.thaw(tokenId.value);
        if (ended) {
          yield* audit.append({
            kind: "controller.promotion.cancelled",
            actor: SYSTEM_ACTOR,
            payload: { promotionTokenId: tokenId.value },
          });
        }
      }),
  };
});

export class PromotionTransfer extends Context.Service<
  PromotionTransfer,
  Effect.Success<typeof make>
>()("hercule/controller/promotion/PromotionTransfer") {}

export const PromotionTransferLayer: Layer.Layer<
  PromotionTransfer,
  never,
  | PromotionTokens
  | PromotionState
  | PromotionExpiry
  | ControllerIdentity
  | HerculeHome
  | MasterKey
  | AuditLog
  | SqlClient.SqlClient
> = Layer.effect(PromotionTransfer)(make);
