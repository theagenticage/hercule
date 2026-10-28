/**
 * Reads an image's bytes the same way for every adapter whose harness takes
 * images inline.
 */
import { readFile } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { describeError, endSentence } from "../report";
import type { LocalAttachment } from "./index";
import { truncateMessage } from "./text";

/**
 * Reads an image the runner cached and returns its bytes in standard base64.
 * Fails with a message for the user, naming the image, when the file cannot
 * be read. The message fits in an adapter error.
 */
export const readAttachmentBase64 = (attachment: LocalAttachment): Effect.Effect<string, string> =>
  Effect.tryPromise({
    try: () => readFile(attachment.path, { encoding: "base64" }),
    catch: (error) =>
      truncateMessage(
        endSentence(
          `The image "${attachment.name}" could not be read on this runner: ${describeError(error)}`,
        ),
      ),
  });
