/**
 * Attachments as the runner sees them: the images a user attached to an
 * input, and the images an agent's tool returned.
 *
 * A frame on the runner socket carries only a reference to each image, never
 * its bytes: one image can be 10 MiB, and the socket also carries every other
 * session's events. Both directions use plain HTTP for the bytes: the runner
 * fetches an input's images before it hands the turn to the harness, and
 * uploads a tool's image before it reports the tool's result.
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

/** The largest image the controller stores: 10 MiB, for an upload and a tool's image alike. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
 * How long the controller waits for a runner to report what it did with an
 * input (`sessionInput`, and a steer). Long enough for a harness to accept a
 * message, short enough that a caller waiting on the reply is not left
 * hanging. An input with images gets `ATTACHMENT_DOWNLOAD_TIMEOUT` on top.
 */
export const SESSION_INPUT_DEADLINE: Duration.Duration = Duration.seconds(10);

/**
 * The longest a runner spends downloading the images of one input before it
 * gives up on that input. The controller adds this to its usual wait for the
 * runner's answer when an input carries images, because the runner answers
 * only after the download. Without that, a slow download would make the
 * controller send the input again.
 */
export const ATTACHMENT_DOWNLOAD_TIMEOUT: Duration.Duration = Duration.minutes(2);

/**
 * A tool's image once the controller has stored it: what a client needs to
 * show it. The bytes are read through `attachment.readContent` with this id.
 */
export const StoredToolImage = Schema.Struct({
  id: StorageId,
  mimeType: ImageMimeType,
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
});

export type StoredToolImage = Schema.Schema.Type<typeof StoredToolImage>;

/**
 * One image in a tool's result, as `item.completed.detail.content` holds it
 * in place of the harness's image block. The runner uploads the bytes and
 * keeps only this reference, so the event never carries them:
 *
 * - `attachment` is the stored image when the upload succeeded;
 * - `unavailable` says, for the user, why the image could not be kept: it was
 *   larger than `MAX_ATTACHMENT_BYTES`, or the upload failed.
 */
export const ToolResultImage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("image"), attachment: StoredToolImage }),
  Schema.Struct({ type: Schema.Literal("image"), unavailable: Fact }),
]);

export type ToolResultImage = Schema.Schema.Type<typeof ToolResultImage>;

/**
 * The HTTP route a runner uploads a tool's image to, with the session's id in
 * the `sessionId` query parameter and the raw bytes as the body. The route
 * is part of the runner protocol, not the operation table: the caller
 * presents a runner's credential. It answers `201` with a `StoredToolImage`.
 */
export const TOOL_IMAGE_UPLOAD_PATH = "/api/v1/runners/tool-images";

/**
 * The longest a runner waits for one tool image's upload. The session's
 * events wait behind it, so a controller that does not answer must not hold
 * them for long. An upload that runs out of time leaves the image
 * `unavailable`.
 */
export const TOOL_IMAGE_UPLOAD_TIMEOUT: Duration.Duration = Duration.seconds(30);
