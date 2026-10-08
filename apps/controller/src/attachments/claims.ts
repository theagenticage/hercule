/**
 * The link between an input and its images, for the sessions domain: an
 * input claims the images it carries, and a frame or a listing reads them
 * back.
 *
 * These run inside the caller's transaction, so the claim and the input row
 * are written together or not at all.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createValidationError,
  type Attachment,
  type Issue,
  type Validation,
} from "@hercule/contract";
import type { AttachmentReference } from "@hercule/protocol";
import { currentStamp } from "../actor";
import { attachmentRepository, type StoredAttachment } from "./repository";

/**
 * How long an upload no input references stays claimable. After that it
 * counts as gone, and the sweep deletes it on its next pass.
 */
export const UNCLAIMED_LIFETIME: Duration.Duration = Duration.hours(24);

/**
 * Returns the oldest upload time, as an ISO string, of an upload no input
 * references that is still claimable now.
 */
export const readUnclaimedCutoff: Effect.Effect<string> = Effect.map(
  Clock.currentTimeMillis,
  (now) => new Date(now - Duration.toMillis(UNCLAIMED_LIFETIME)).toISOString(),
);

/**
 * The message of the issue for an attachment that is gone, that someone else
 * uploaded, or that waited longer than `UNCLAIMED_LIFETIME` to be sent.
 */
export const EXPIRED_ATTACHMENT_MESSAGE = "This image expired; attach it again.";

/**
 * Returns the references of the images with these ids, in the same order,
 * for an input about to claim them with `claimAttachments`.
 *
 * Each image must exist, must have been uploaded by the current actor, and
 * must be younger than `UNCLAIMED_LIFETIME`, unless it is in `carried`, the
 * images the input already carries: an edit that sends those back keeps
 * them, whoever uploaded them and whenever. Fails with
 * `Validation` otherwise, with an issue at `["attachments", "<i>"]`
 * for each image that fails, so a client can mark the one to attach again.
 * An image someone else uploaded gets the same message as one the sweep
 * deleted, so nobody learns of another's uploads.
 *
 * The images are read with a query rather than left to the foreign key. Run
 * inside the transaction that claims them: the transaction holds SQLite's one
 * write lock, so the sweep cannot delete an image between this read and the
 * claim.
 */
export const readClaimableAttachments = (
  ids: ReadonlyArray<string>,
  carried: ReadonlyArray<AttachmentReference> = [],
): Effect.Effect<ReadonlyArray<AttachmentReference>, Validation | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (ids.length === 0) return [];
    const attachments = yield* attachmentRepository;
    const actor = yield* currentStamp;
    const rows = new Map((yield* attachments.listByIds(ids)).map((row) => [row.id, row]));
    const carriedIds = new Set(carried.map((reference) => reference.id));
    const cutoff = yield* readUnclaimedCutoff;
    const accepted: Array<StoredAttachment> = [];
    const issues: Array<Issue> = [];
    ids.forEach((id, index) => {
      const row = rows.get(id);
      if (
        row !== undefined &&
        (carriedIds.has(id) || (row.actor === actor && row.createdAt >= cutoff))
      )
        accepted.push(row);
      else
        issues.push({ path: ["attachments", String(index)], message: EXPIRED_ATTACHMENT_MESSAGE });
    });
    if (issues.length > 0) return yield* Effect.fail(createValidationError(issues));
    return accepted.map(buildReference);
  });

/**
 * Makes these images, in this order, the ones the input carries, replacing
 * any it carried before. Pass an empty list to remove them all. Read the
 * references with `readClaimableAttachments` in the same transaction.
 */
export const claimAttachments = (
  inputId: string,
  references: ReadonlyArray<AttachmentReference>,
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.flatMap(attachmentRepository, (attachments) =>
    attachments.replaceReferences(
      inputId,
      references.map((reference) => reference.id),
    ),
  );

/**
 * Returns the images each input carries, in order, keyed by input id. An
 * input with none has no entry. One query serves any number of inputs.
 */
export const listInputAttachments = (
  inputIds: ReadonlyArray<string>,
): Effect.Effect<
  ReadonlyMap<string, ReadonlyArray<AttachmentReference>>,
  SqlError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const attachments = yield* attachmentRepository;
    const byInput = yield* attachments.listReferences(inputIds);
    return new Map([...byInput].map(([inputId, rows]) => [inputId, rows.map(buildReference)]));
  });

/** Returns the facts a frame carries about an image: never the uploader or the upload time. */
const buildReference = (row: StoredAttachment): AttachmentReference => ({
  id: row.id,
  name: row.name,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
});

/**
 * Returns the attachment in the contract's shape: the reference without the
 * digest, which only a runner checks.
 */
export const excludeDigest = (reference: AttachmentReference): Attachment => ({
  id: reference.id,
  name: reference.name,
  mimeType: reference.mimeType,
  sizeBytes: reference.sizeBytes,
});
