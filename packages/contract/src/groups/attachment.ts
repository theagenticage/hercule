/**
 * Attachments: images a user uploads to send with an input.
 *
 * An upload is a step of its own, before the input: `attachment.create` takes
 * the raw bytes of one image and returns its record, and the input then lists
 * the ids in `attachments`. The controller reads the type from the file's
 * first bytes, so a caller never declares it. An attachment no input
 * references is deleted after 24 hours, or sooner with `attachment.delete`.
 */
import { Schema } from "effect";
import { ImageMimeType } from "@hercule/protocol";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id } from "../ids";
import { Authenticated } from "../security";
import { bounded } from "../strings";

/** Re-exported from the protocol, where the runner reads them, so both use the same values. */
export {
  IMAGE_MIME_TYPES,
  ImageMimeType,
  MAX_ATTACHMENT_BYTES,
  ToolResultImage,
} from "@hercule/protocol";

/** The most images one input may carry. */
export const MAX_ATTACHMENTS_PER_INPUT = 10;

/** The longest file name an upload accepts. */
export const MAX_ATTACHMENT_NAME_LENGTH = 255;

/** The id of an uploaded attachment, as `attachment.create` returns it and an input lists it. */
export const AttachmentId = Id;

/**
 * The file name an upload gives: at most `MAX_ATTACHMENT_NAME_LENGTH`
 * characters, with no control characters. The name is shown to the user and
 * passed to the agent, so a line break or a NUL in it could cut it short or
 * forge a line of its own in what they read.
 */
const AttachmentName = bounded(1, MAX_ATTACHMENT_NAME_LENGTH).check(
  Schema.makeFilter((name: string) =>
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f]/.test(name)
      ? "A file name cannot contain line breaks, tabs or other control characters. Rename the file and upload it again."
      : undefined,
  ),
);

/** One uploaded image. The bytes are read through `attachment.readContent`. */
export const Attachment = Schema.Struct({
  id: AttachmentId,
  /** The file name the uploader gave; shown to the user and the agent, never used as a path. */
  name: Schema.String,
  mimeType: ImageMimeType,
  sizeBytes: Schema.Int,
});

export type Attachment = Schema.Schema.Type<typeof Attachment>;

/** The bytes of one image, as the request body or the response body carries them. */
const ImageBytes = Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array());

export const attachment = HttpApiGroup.make("attachment")
  .add(
    HttpApiEndpoint.post("create", "/attachments", {
      query: Schema.Struct({ name: AttachmentName }),
      payload: ImageBytes,
      // The request creates a new attachment, so it returns `201` rather than
      // the `200` an edit returns.
      success: HttpApiSchema.status(201)(Attachment),
      // `validation`: the name has control characters, the bytes are not one
      // of the accepted image types or there are more than
      // `MAX_ATTACHMENT_BYTES` of them, or the uploader's images that no
      // input claims yet would pass 200 MiB.
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("readContent", "/attachments/:id/content", {
      params: { id: AttachmentId },
      // The response's `content-type` is the attachment's `mimeType`.
      success: ImageBytes,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    // Deletes an upload the caller's actor made and no input references yet,
    // such as an image the user removed before sending. Any other id is
    // `not_found`, by the same rule as `readContent`, so a caller cannot tell
    // someone else's upload from an id that does not exist. An image an
    // agent's tool returned is never deleted here: it lives as long as the
    // session's transcript does.
    HttpApiEndpoint.delete("delete", "/attachments/:id", {
      params: { id: AttachmentId },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
