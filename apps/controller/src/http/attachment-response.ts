/**
 * The response that carries an attachment's bytes, for the user's read and
 * the runner's fetch alike.
 */
import type * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { AttachmentFile } from "../attachments";

/**
 * Builds the response that streams the attachment's file. Fails with
 * `PlatformError` when the file cannot be read.
 *
 * The bytes are an upload, so the headers keep a browser from treating them
 * as anything but the image they were checked to be:
 *
 * - `content-type` is the type read from the bytes at upload. It is a header
 *   because Bun ignores the `contentType` option of a file response.
 * - `x-content-type-options: nosniff` stops a browser from guessing another
 *   type from the bytes.
 * - `content-security-policy: sandbox; default-src 'none'` runs nothing and
 *   loads nothing, even if the file is opened on its own as a page.
 * - `cache-control: private, no-store` keeps a shared cache from storing an
 *   image only some callers may read.
 */
export const buildAttachmentResponse = (
  file: AttachmentFile,
): Effect.Effect<HttpServerResponse.HttpServerResponse, PlatformError, HttpPlatform> =>
  HttpServerResponse.file(file.path, {
    headers: {
      "content-type": file.mimeType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, no-store",
    },
  });
