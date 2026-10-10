/**
 * Takes the images out of the tool results in a Claude SDK message, before
 * the normalizer sees it, so no event carries an image's bytes.
 *
 * For example, a Claude `Read` of a PNG returns the image twice: as an image block with
 * base64 data in the `tool_result`'s content, and again in the message's
 * `tool_use_result`, the tool's structured output. The normalizer passes the
 * first on in `item.completed.detail.content` and the whole message in `raw`.
 * One image can be megabytes, and the runner socket carries every session's
 * events, so each image is uploaded to the controller and only a reference to
 * it stays in the message (spec 06, image blocks in tool results).
 */
import * as Effect from "effect/Effect";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { MAX_ATTACHMENT_BYTES, type ToolResultImage } from "@hercule/protocol";
import type { AttachmentUploader } from "../attachments";

/** An image found in a tool result, and how to put its reference in its place. */
interface FoundImage {
  /** The image's base64 data. */
  readonly data: string;
  /** Returns the object the image was found in, with `reference` in the image's place. */
  readonly replace: (reference: ToolResultImage) => unknown;
}

/**
 * The most images of one message that upload at once. Each upload holds its
 * decoded bytes, up to `MAX_ATTACHMENT_BYTES`, until the controller answers,
 * so a tool that returns dozens of images must not decode them all together.
 */
const MAX_PARALLEL_UPLOADS = 4;

/** The reason an image too large for the controller is not kept. */
const IMAGE_TOO_LARGE = `The image is larger than ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB, so it was not kept.`;

/** The reason an image whose upload had not started when the session stopped is not kept. */
const SESSION_STOPPED = "The session stopped before the image was kept.";

/** Returns `value` as a record when it is a plain object, or undefined. */
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Checks whether a declared media type is an image's. */
const isImageMimeType = (mimeType: unknown): boolean =>
  typeof mimeType === "string" && mimeType.startsWith("image/");

/**
 * Returns the image `value` holds itself, or undefined when it holds none.
 * Five shapes hold an image's bytes in a tool result:
 *
 * - `{ type: "image", source: { type: "base64", data, media_type } }`, the
 *   Messages API's image block, in a `tool_result`'s content and in what a
 *   subagent or an MCP tool repeats of it;
 * - `{ type: "image", data, mimeType }`, MCP's image block, as an MCP tool's
 *   `structuredContent` may hold it;
 * - `{ type: "resource", resource: { blob, mimeType } }`, MCP's embedded
 *   resource;
 * - `{ base64, type }`, the `file` of Claude's `Read` of an image;
 * - `{ image_data, media_type }`, a cell output's image in Claude's `Read`
 *   of a notebook.
 *
 * These are every shape of MCP's content types (text, image, audio,
 * resource link, resource) and of Claude's own tools that can carry an
 * image's bytes. A block is replaced whole; in the last two shapes only the
 * field with the data is. A shape counts only when its declared media type
 * is an image's, so a PDF, an audio clip or another blob is left as it is. An
 * image the controller does not store, such as a BMP, is still uploaded: it
 * is refused and becomes `unavailable`, so its bytes are dropped all the same.
 */
const recognizeImage = (value: Readonly<Record<string, unknown>>): FoundImage | undefined => {
  const recognizeBlock = (data: unknown, mimeType: unknown): FoundImage | undefined =>
    typeof data === "string" && isImageMimeType(mimeType)
      ? { data, replace: (reference) => reference }
      : undefined;
  const recognizeField = (key: string, mimeType: unknown): FoundImage | undefined => {
    const data = value[key];
    return typeof data === "string" && isImageMimeType(mimeType)
      ? { data, replace: (reference) => ({ ...value, [key]: reference }) }
      : undefined;
  };
  if (value.type === "image") {
    const source = asRecord(value.source);
    return source?.type === "base64"
      ? recognizeBlock(source.data, source.media_type)
      : recognizeBlock(value.data, value.mimeType);
  }
  if (value.type === "resource") {
    const resource = asRecord(value.resource);
    return resource === undefined ? undefined : recognizeBlock(resource.blob, resource.mimeType);
  }
  if ("base64" in value) return recognizeField("base64", value.type);
  if ("image_data" in value) return recognizeField("image_data", value.media_type);
  return undefined;
};

/** Adds every image inside `value`, at any depth, to `found`, in the order they appear. */
const findImages = (value: unknown, found: Array<FoundImage>): void => {
  if (Array.isArray(value)) {
    for (const item of value) findImages(item, found);
    return;
  }
  const record = asRecord(value);
  if (record === undefined) return;
  const image = recognizeImage(record);
  if (image !== undefined) found.push(image);
  else for (const field of Object.values(record)) findImages(field, found);
};

/**
 * Returns a copy of `value` in which each image `findImages` found holds its
 * reference from `references`, keyed by the image's data, instead.
 */
const replaceImages = (
  value: unknown,
  references: ReadonlyMap<string, ToolResultImage>,
): unknown => {
  if (Array.isArray(value)) return value.map((item) => replaceImages(item, references));
  const record = asRecord(value);
  if (record === undefined) return value;
  const image = recognizeImage(record);
  const reference = image === undefined ? undefined : references.get(image.data);
  if (image !== undefined && reference !== undefined) return image.replace(reference);
  return Object.fromEntries(
    Object.entries(record).map(([key, field]) => [key, replaceImages(field, references)]),
  );
};

/** Checks whether a content block of a user message is a `tool_result`. */
const isToolResultBlock = (block: unknown): block is { readonly content?: unknown } =>
  asRecord(block)?.type === "tool_result";

/**
 * Returns the number of bytes base64 `data` decodes to, without decoding it,
 * so an image too large to keep is refused before it is copied in memory.
 */
const computeDecodedSize = (data: string): number => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
};

/**
 * Uploads the image whose base64 is `data` and returns its reference. The image is decoded only
 * when its upload starts. These images are not uploaded:
 *
 * - an image larger than `MAX_ATTACHMENT_BYTES`, which the controller would
 *   refuse;
 * - any image once `signal` is aborted, because the session stopped.
 */
const uploadImage = (
  uploader: AttachmentUploader,
  sessionId: string,
  data: string,
  signal: AbortSignal,
): Effect.Effect<ToolResultImage> =>
  Effect.suspend(() => {
    if (signal.aborted) return Effect.succeed({ type: "image", unavailable: SESSION_STOPPED });
    if (computeDecodedSize(data) > MAX_ATTACHMENT_BYTES) {
      return Effect.succeed({ type: "image", unavailable: IMAGE_TOO_LARGE });
    }
    return uploader.upload(sessionId, Buffer.from(data, "base64"), signal);
  });

/**
 * Returns the message with each image in its tool results replaced by a
 * `ToolResultImage`. Images are found by shape (see `recognizeImage`) in
 * two places: the content of each `tool_result` block, and
 * `tool_use_result`, the tool's structured output. The user's own images in
 * a prompt are not in either, so they are never taken for a tool's.
 *
 * Each distinct image is uploaded once, and up to `MAX_PARALLEL_UPLOADS`
 * uploads of one message run in parallel. A message with no such image is
 * returned as the same object, with no work done, because every SDK message
 * passes through here. Aborting `signal`, when the session stops, ends the
 * uploads in progress and starts no more. Never fails: an image that cannot
 * be kept becomes `unavailable`, and its bytes are dropped all the same.
 */
export const replaceToolResultImages = (
  uploader: AttachmentUploader,
  sessionId: string,
  sdk: SDKMessage,
  signal: AbortSignal,
): Effect.Effect<SDKMessage> => {
  if (sdk.type !== "user" || !Array.isArray(sdk.message.content)) return Effect.succeed(sdk);
  const blocks: ReadonlyArray<unknown> = sdk.message.content;
  const found: Array<FoundImage> = [];
  for (const block of blocks) if (isToolResultBlock(block)) findImages(block.content, found);
  findImages(sdk.tool_use_result, found);
  if (found.length === 0) return Effect.succeed(sdk);
  const distinct = new Set(found.map((image) => image.data));
  return Effect.map(
    Effect.forEach(
      distinct,
      (data) =>
        Effect.map(
          uploadImage(uploader, sessionId, data, signal),
          (reference) => [data, reference] as const,
        ),
      { concurrency: MAX_PARALLEL_UPLOADS },
    ),
    (entries) => {
      const references = new Map(entries);
      const content = blocks.map((block) =>
        isToolResultBlock(block)
          ? { ...block, content: replaceImages(block.content, references) }
          : block,
      );
      // The SDK's types have no reference block, so the copy is cast back to
      // an SDK message. The normalizer passes a tool result's content array
      // through untouched, and the event's `detail` is plain JSON.
      return {
        ...sdk,
        message: { ...sdk.message, content },
        ...(sdk.tool_use_result === undefined
          ? {}
          : { tool_use_result: replaceImages(sdk.tool_use_result, references) }),
      } as SDKMessage;
    },
  );
};
