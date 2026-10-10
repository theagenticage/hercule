/**
 * Reads an image's bytes the same way for every adapter whose harness takes
 * images inline.
 */
import { readFile } from "node:fs/promises";
import * as Effect from "effect/Effect";
import type { LocalAttachment } from "./index";

/**
 * Reads an image the runner cached and returns its bytes in standard base64.
 * Fails with a message naming the image when the file cannot be read.
 */
export const readAttachmentBase64 = (attachment: LocalAttachment): Effect.Effect<string, string> =>
  Effect.tryPromise({
    try: () => readFile(attachment.path, { encoding: "base64" }),
    catch: (error) =>
      `the image "${attachment.name}" could not be read from ${attachment.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
  });
