/**
 * Checks and labels for one image file a user picks, pastes or drops, before
 * it is uploaded.
 */
import { IMAGE_MIME_TYPES, MAX_ATTACHMENT_BYTES } from "@hercule/contract";

const MEBIBYTE = 1024 * 1024;

/** A file the user picked, pasted or dropped: a `File`, or any `Blob` with a name. */
export type ImageFile = Blob & { readonly name: string };

/**
 * Formats an image's size for its tile: `2.4 MB` from one MiB up, with one
 * decimal, and `12 KB` below that, never `0 KB`.
 *
 * This does not use `formatBytes`, which writes `KiB` and `MiB` and drops the
 * decimal from ten up: a size on a shelf tile reads like a size in a file
 * picker, and the 10 MB limit must not show as "10 MiB" in one place and
 * "10.0 MB" in another.
 */
export const formatAttachmentSize = (bytes: number): string =>
  bytes >= MEBIBYTE
    ? `${(bytes / MEBIBYTE).toFixed(1)} MB`
    : `${String(Math.max(1, Math.ceil(bytes / 1024)))} KB`;

/**
 * Checks that a file can be attached: an accepted image type, not empty, and
 * no larger than `MAX_ATTACHMENT_BYTES`. Returns `undefined` when it can, or
 * the refusal to show, which names the file. The type is the one the browser
 * guessed from the name; the controller checks the bytes again on upload.
 */
export const checkImageFile = (file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}): string | undefined => {
  if (!(IMAGE_MIME_TYPES as ReadonlyArray<string>).includes(file.type))
    return `"${file.name}" is not an image Hercule can send. Attach a PNG, JPEG, GIF or WebP image.`;
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES)
    return `"${file.name}" is ${formatAttachmentSize(file.size)}; an image can be up to ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)}.`;
  return undefined;
};
