/**
 * The attachment operations of the API, `attachment.create`,
 * `attachment.readContent` and `attachment.delete`, plus what the rest of the
 * controller needs from attachments: the runner's fetch and one pass of the
 * sweep, which the controller daemon repeats.
 *
 * An attachment's bytes are one immutable file at `<dataDir>/attachments/<id>`
 * and its metadata is a row in `attachments`. The two are written in this
 * order, and no transaction ever waits on the disk:
 *
 * - An upload is written to a temp file, which is renamed to the id, and only
 *   then is the row inserted. A rename is atomic, so a half-written file never
 *   sits under a real id. If the insert fails, the file is removed.
 * - The sweep and `attachment.delete` delete rows in their own transaction,
 *   and remove the files after that transaction commits.
 *
 * A crash between the disk and the database leaves a file with no row. The
 * sweep removes such files, and leftover temp files, once they are older than
 * a day.
 *
 * An attachment is "claimed" when an input references it. An attachment no
 * input references can no longer be claimed a day after its upload
 * (`UNCLAIMED_LIFETIME`), and the sweep deletes it. That also covers one that
 * `input.update` removed from a queued input.
 */
import { createHash } from "node:crypto";
import { readdir, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createNotFoundError,
  createValidationError,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type Forbidden,
  type ImageMimeType,
  type NotFound,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { HerculeHome } from "../config";
import { mintUuid, nowIso, UUID_PATTERN, uuidToString, withTransaction } from "../db";
import { excludeDigest, readUnclaimedCutoff, UNCLAIMED_LIFETIME } from "./claims";
import { attachmentRepository, type StoredAttachment, type UnclaimedUpload } from "./repository";
import { detectImageMimeType } from "./sniff";

/** A disk operation on an attachment file failed. `action` is the verb the message uses. */
class AttachmentFileError extends Schema.TaggedError<AttachmentFileError>()("AttachmentFileError", {
  action: Schema.Literals(["write", "list", "remove"]),
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

/** One upload: the file name the uploader gave, and the bytes. */
interface NewAttachment {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Where an attachment's bytes are on disk, and what type they are. */
export interface AttachmentFile {
  readonly path: string;
  readonly mimeType: ImageMimeType;
}

/**
 * The most bytes of attachments one actor may hold that no input claims yet.
 * Without it, an actor could fill the disk with uploads it never sends,
 * since the sweep only removes them after a day.
 */
const MAX_UNCLAIMED_BYTES = 200 * 1024 * 1024;

/**
 * Returns how long until enough of `counted` expires that `sizeBytes` more
 * fits under `MAX_UNCLAIMED_BYTES`, in milliseconds. `counted` is sorted
 * oldest first, and is the actor's uploads that still count.
 */
const computeQuotaWait = (
  counted: ReadonlyArray<UnclaimedUpload>,
  sizeBytes: number,
  now: number,
): number => {
  let held = counted.reduce((total, upload) => total + upload.sizeBytes, 0);
  for (const upload of counted) {
    held -= upload.sizeBytes;
    if (held + sizeBytes <= MAX_UNCLAIMED_BYTES)
      return Date.parse(upload.createdAt) + Duration.toMillis(UNCLAIMED_LIFETIME) - now;
  }
  // Not reached: one upload is at most `MAX_ATTACHMENT_BYTES`, far below the quota.
  return Duration.toMillis(UNCLAIMED_LIFETIME);
};

/**
 * Describes a wait as "about 3 hours" or "about 25 minutes". Rounded up, so
 * the user who waits that long finds the room there. The wait is relative
 * because the controller does not know the user's time zone.
 */
const describeWait = (millis: number): string => {
  const minutes = Math.max(1, Math.ceil(millis / 60_000));
  if (minutes < 60) return minutes === 1 ? "about a minute" : `about ${String(minutes)} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "about an hour" : `about ${String(hours)} hours`;
};

const NOT_FOUND = "no attachment with that id";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const attachments = yield* attachmentRepository;
  const directory = join((yield* HerculeHome).dataDir, "attachments");

  const buildPath = (id: string): string => join(directory, id);

  const removeFile = (path: string): Effect.Effect<void, AttachmentFileError> =>
    Effect.tryPromise({
      try: () => rm(path, { force: true }),
      catch: (cause) => new AttachmentFileError({ action: "remove", path, cause }),
    });

  /** Writes the bytes to a temp file, then renames it to the id, so the id never names a partial file. */
  const writeFileAtomically = (
    id: string,
    bytes: Uint8Array,
  ): Effect.Effect<void, AttachmentFileError> => {
    const temp = join(directory, `${id}.upload`);
    return Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temp, bytes, { mode: 0o600 });
        await rename(temp, buildPath(id));
      },
      catch: (cause) => new AttachmentFileError({ action: "write", path: temp, cause }),
    }).pipe(Effect.tapError(() => Effect.ignore(removeFile(temp))));
  };

  /**
   * Removes the files in the directory that have no row and are older than
   * `cutoff`: temp files of interrupted uploads, and files whose row was
   * never inserted or was deleted by a sweep that stopped before removing
   * them.
   *
   * The directory is listed before the ids are read. An upload renames its
   * file before it inserts the row, so a file listed here whose row is not
   * read yet may be an upload in progress. The age check keeps that file,
   * and only the few files with no row are checked for age.
   */
  const removeStrayFiles = (
    cutoffMillis: number,
  ): Effect.Effect<void, AttachmentFileError | SqlError> =>
    Effect.gen(function* () {
      const names = yield* Effect.tryPromise({
        try: () =>
          readdir(directory).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          }),
        catch: (cause) => new AttachmentFileError({ action: "list", path: directory, cause }),
      });
      const kept = new Set(yield* attachments.listIds());
      const stray = yield* Effect.tryPromise({
        try: async () => {
          const old: Array<string> = [];
          for (const name of names.filter((one) => !kept.has(one))) {
            const found = await stat(join(directory, name)).catch(
              (error: NodeJS.ErrnoException) => {
                // Removed since the listing, by an upload's rename or its cleanup.
                if (error.code === "ENOENT") return undefined;
                throw error;
              },
            );
            if (found !== undefined && found.mtimeMs < cutoffMillis) old.push(name);
          }
          return old;
        },
        catch: (cause) => new AttachmentFileError({ action: "list", path: directory, cause }),
      });
      yield* Effect.forEach(stray, (name) => removeFile(buildPath(name)), { discard: true });
    });

  /** Fails with `Validation` with one issue, at no field, that has this message. */
  const failValidation = (message: string): Effect.Effect<never, Validation> =>
    Effect.fail(createValidationError([{ path: [], message }]));

  /**
   * Inserts the attachment's row unless the actor's uploads that still count
   * would pass `MAX_UNCLAIMED_BYTES` with it. An upload counts while no input
   * references it and it is younger than `UNCLAIMED_LIFETIME`: an older one
   * can no longer be claimed, so it holds no room even before the sweep
   * deletes it. Fails with `Validation` when the quota refuses, with a
   * message that says how long until enough room is free.
   *
   * The read and the insert are one transaction, which holds SQLite's one
   * write lock, so two uploads at once cannot both see the same room.
   */
  const insertWithinQuota = (
    stored: StoredAttachment,
  ): Effect.Effect<void, Validation | SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const counted = yield* attachments.listUnclaimed(stored.actor, yield* readUnclaimedCutoff);
        const held = counted.reduce((total, upload) => total + upload.sizeBytes, 0);
        if (held + stored.sizeBytes > MAX_UNCLAIMED_BYTES) {
          const wait = computeQuotaWait(counted, stored.sizeBytes, yield* Clock.currentTimeMillis);
          return yield* failValidation(
            `"${stored.name}" would take your images that are not sent yet past 200 MB. ` +
              `Remove some images, or try again in ${describeWait(wait)}.`,
          );
        }
        yield* attachments.insert(stored);
      }),
    );

  return {
    /**
     * Deletes the attachments nobody claimed within `UNCLAIMED_LIFETIME` and
     * their files, then the stray files older than that. One pass; the
     * controller daemon repeats it.
     */
    sweep: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cutoffMillis = now - Duration.toMillis(UNCLAIMED_LIFETIME);
      const deleted = yield* withTransaction(
        sql,
        attachments.deleteUnreferenced(new Date(cutoffMillis).toISOString()),
      );
      // After the commit, so a rolled-back delete never loses a file.
      yield* Effect.forEach(deleted, (id) => removeFile(buildPath(id)), { discard: true });
      yield* removeStrayFiles(cutoffMillis);
    }),

    /**
     * Stores one uploaded image and returns its record (`attachment.create`).
     * The type is read from the bytes, never from the name. Fails with
     * `Forbidden` without the grant, and with `Validation` when:
     *
     * - the bytes are more than `MAX_ATTACHMENT_BYTES`;
     * - the bytes are not a PNG, JPEG, GIF or WebP image;
     * - the actor's uploads that still count would pass `MAX_UNCLAIMED_BYTES`
     *   with this one (`insertWithinQuota`).
     *
     * The file is written before the row, outside the transaction, so no
     * transaction waits on the disk. When the row is not inserted, the file
     * is removed.
     */
    create: (
      upload: NewAttachment,
    ): Effect.Effect<Attachment, Forbidden | Validation | AttachmentFileError | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("attachment.create");
        const sizeBytes = upload.bytes.byteLength;
        if (sizeBytes > MAX_ATTACHMENT_BYTES)
          return yield* failValidation(
            `"${upload.name}" is larger than 10 MB, the most an image may be`,
          );
        const mimeType = detectImageMimeType(upload.bytes);
        if (mimeType === undefined)
          return yield* failValidation(`"${upload.name}" is not a PNG, JPEG, GIF or WebP image`);
        const stored: StoredAttachment = {
          id: uuidToString(mintUuid()),
          name: upload.name,
          mimeType,
          sizeBytes,
          sha256: createHash("sha256").update(upload.bytes).digest("hex"),
          actor: yield* currentStamp,
          createdAt: yield* nowIso,
        };
        yield* writeFileAtomically(stored.id, upload.bytes);
        yield* insertWithinQuota(stored).pipe(
          Effect.tapError(() => Effect.ignore(removeFile(buildPath(stored.id)))),
        );
        return excludeDigest(stored);
      }),

    /**
     * Returns where the image's bytes are and their type
     * (`attachment.readContent`). The caller may read an image some input
     * references, or one it uploaded itself that no input references yet.
     * Fails with `Forbidden` without the grant, and with `NotFound` for any
     * other image, so a caller cannot tell another's upload from a missing one.
     */
    readContent: (id: string): Effect.Effect<AttachmentFile, Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("attachment.readContent");
        const found = yield* attachments.readVisible(id, yield* currentStamp);
        if (Option.isNone(found)) return yield* Effect.fail(createNotFoundError(NOT_FOUND));
        return { path: buildPath(id), mimeType: found.value.mimeType };
      }),

    /**
     * Deletes an image the caller uploaded that no input references yet, and
     * its file (`attachment.delete`). A client calls it when the user removes
     * an image before sending, so the upload stops counting against the
     * quota at once. Fails with `Forbidden` without the grant, and with
     * `NotFound` for any other image, by the same rule as `readContent`.
     */
    delete: (
      id: string,
    ): Effect.Effect<
      Record<string, never>,
      Forbidden | NotFound | AttachmentFileError | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("attachment.delete");
        const actor = yield* currentStamp;
        if (!(yield* withTransaction(sql, attachments.deleteUnclaimed(id, actor))))
          return yield* Effect.fail(createNotFoundError(NOT_FOUND));
        // After the commit, so a rolled-back delete never loses a file.
        yield* removeFile(buildPath(id));
        return {};
      }),

    /**
     * Returns where the image's bytes are and their type, for the runner
     * with that id. A runner may fetch only an image that an input of a
     * session placed on it references. Fails with `NotFound` for any other
     * id, including one that is not an id at all.
     */
    readForRunner: (
      id: string,
      runnerId: string,
    ): Effect.Effect<AttachmentFile, NotFound | SqlError> =>
      Effect.gen(function* () {
        const found = UUID_PATTERN.test(id)
          ? yield* attachments.readForRunner(id, runnerId)
          : Option.none();
        if (Option.isNone(found)) return yield* Effect.fail(createNotFoundError(NOT_FOUND));
        return { path: buildPath(id), mimeType: found.value.mimeType };
      }),
  };
});

/** The attachment service. */
export class AttachmentService extends Context.Service<
  AttachmentService,
  Effect.Success<typeof make>
>()("hercule/controller/attachments/AttachmentService") {}

export const AttachmentServiceLayer: Layer.Layer<
  AttachmentService,
  never,
  SqlClient.SqlClient | HerculeHome
> = Layer.effect(AttachmentService)(make);
