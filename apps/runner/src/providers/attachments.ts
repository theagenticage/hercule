/**
 * What every adapter does the same way with the images of an input: the line
 * that tells the agent where each image is saved, and reading an image's
 * bytes for a harness that takes them inline.
 */
import { readFile } from "node:fs/promises";
import * as Effect from "effect/Effect";
import type { LocalAttachment } from "./index";

/**
 * Returns the user's text, then a blank line, then one line per image naming
 * the file the runner saved it in, for example
 * `[Attached image "image.png" is saved at: /path]`. Returns the text
 * unchanged when the input has no images, and only the lines when the text is
 * empty. `buildHarnessPrompt` calls it to build the prompt the harness gets.
 *
 * The name is written as a JSON string, so a name with a quote or a line
 * break stays inside its own line and cannot pass for another line of the
 * prompt.
 *
 * The harness sees each image itself; the line is there so the agent can use
 * the file too, for example to copy a screenshot into the repository.
 */
export const appendAttachmentPaths = (
  text: string,
  attachments: ReadonlyArray<LocalAttachment> | undefined,
): string => {
  if (attachments === undefined || attachments.length === 0) return text;
  const lines = attachments
    .map(
      (attachment) =>
        `[Attached image ${JSON.stringify(attachment.name)} is saved at: ${attachment.path}]`,
    )
    .join("\n");
  return text === "" ? lines : `${text}\n\n${lines}`;
};

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
