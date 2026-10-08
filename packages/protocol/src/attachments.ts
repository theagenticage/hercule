/**
 * Images a user attached to an input, as the runner sees them.
 *
 * A frame on the runner socket carries only a reference to each image, never
 * its bytes: one image can be 10 MiB, and the socket also carries every other
 * session's events. The runner fetches the bytes over HTTP before it hands the
 * turn to the harness.
 */
import { Duration, Schema } from "effect";

import { Fact, StorageId } from "./primitives";

/**
 * The capability for images in input. The runner lists it at hello when it
 * can fetch an attachment and give it to a harness; the controller lists it
 * when it sends `TurnInput.attachments`. A runner on an older build would
 * ignore the field and run the text alone, so the controller refuses input
 * with images for a runner whose hello does not list this.
 */
export const ATTACHMENTS_CAPABILITY = "attachments";

/**
 * The image types an input accepts. The controller reads the type from the
 * file's first bytes, so a file is one of these whatever its name says.
 */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const ImageMimeType = Schema.Literals(IMAGE_MIME_TYPES);

export type ImageMimeType = Schema.Schema.Type<typeof ImageMimeType>;

/** A SHA-256 digest as 64 lowercase hex characters. */
const Sha256 = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/, {
    title: "sha256",
    description: "a SHA-256 digest in lowercase hex",
  }),
);

/**
 * One image of an input, as a frame carries it: what the runner needs to
 * fetch the bytes and check them, never the bytes themselves.
 *
 * - `id` is a `StorageId` because the runner uses it as the name of the
 *   file it caches the image in.
 * - `sha256` is the digest of the bytes, so the runner can check what it
 *   fetched before it hands the file to the harness.
 */
export const AttachmentReference = Schema.Struct({
  id: StorageId,
  name: Fact,
  mimeType: ImageMimeType,
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: Sha256,
});

export type AttachmentReference = Schema.Schema.Type<typeof AttachmentReference>;

/**
 * The longest a runner spends downloading the images of one input before it
 * gives up on that input. The controller adds this to its usual wait for the
 * runner's answer when an input carries images, because the runner answers
 * only after the download. Without that, a slow download would make the
 * controller send the input again.
 */
export const ATTACHMENT_DOWNLOAD_TIMEOUT: Duration.Duration = Duration.minutes(2);
