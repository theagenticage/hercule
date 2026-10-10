/**
 * Reads an image's type from its first bytes. Two roles use it:
 *
 * - the controller decides an attachment's type with it. The type is never
 *   taken from the uploader: neither a declared media type nor the file name
 *   decides it, so an attachment is always one of the four image types the
 *   harnesses accept, whatever the client claims;
 * - the runner tells with it whether a blob a tool returned with no media
 *   type is an image.
 */
import type { ImageMimeType } from "./attachments";

/** The bytes each image type starts with, and the offset they start at. */
const SIGNATURES: ReadonlyArray<{
  readonly mimeType: ImageMimeType;
  readonly parts: ReadonlyArray<{ readonly offset: number; readonly bytes: ReadonlyArray<number> }>;
}> = [
  {
    mimeType: "image/png",
    parts: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  { mimeType: "image/jpeg", parts: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
  // "GIF8", shared by GIF87a and GIF89a.
  { mimeType: "image/gif", parts: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }] },
  // "RIFF", then four bytes of length, then "WEBP".
  {
    mimeType: "image/webp",
    parts: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
];

/**
 * Returns the image type the bytes start with, or `undefined` when they are
 * not a PNG, JPEG, GIF or WebP image.
 */
export const detectImageMimeType = (bytes: Uint8Array): ImageMimeType | undefined =>
  SIGNATURES.find((signature) =>
    signature.parts.every((part) =>
      part.bytes.every((byte, index) => bytes[part.offset + index] === byte),
    ),
  )?.mimeType;
