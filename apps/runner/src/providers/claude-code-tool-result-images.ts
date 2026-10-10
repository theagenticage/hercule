/**
 * Takes the images out of the tool results in a Claude SDK message, before
 * the normalizer sees it, so no event carries an image's bytes.
 *
 * For example, a Claude `Read` of a PNG returns the image twice: as an image
 * block with base64 data in the `tool_result`'s content, and again in the
 * message's `tool_use_result`, the tool's structured output. The normalizer
 * passes the first on in `item.completed.detail.content` and the whole
 * message in `raw`. One image can be megabytes, and the runner socket
 * carries every session's events, so each image is uploaded to the
 * controller and only a reference to it stays in the message (spec 06,
 * images in tool results).
 *
 * What is taken out:
 *
 * - an image in a known shape (see `readImageData` and
 *   `readImageFieldData`) is replaced by its reference;
 * - an image as a data URL in text has its base64 replaced by a placeholder;
 * - any other copy of a found image's base64, spelled exactly the same, in
 *   any text or object key, is replaced by the same placeholder.
 *
 * What is not taken out:
 *
 * - an image a tool's structured output holds only in a shape of the tool's
 *   own invention, because no list of shapes covers arbitrary JSON;
 * - a copy of a found image encoded differently, for example re-padded,
 *   wrapped over lines, or JSON-escaped (`\/` for `/`), because base64 in
 *   text has endless equivalent spellings.
 *
 * Either stays in the event. The runner's supervisor still shrinks any event
 * too large for one frame.
 */
import * as Effect from "effect/Effect";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { detectImageMimeType, MAX_ATTACHMENT_BYTES, type ToolResultImage } from "@hercule/protocol";
import type { AttachmentUploader } from "../attachments";

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

/**
 * Matches each data URL that holds a base64 image, anywhere in text. The
 * first group is the image's base64, which ends at the first character
 * base64 does not use, so the text around the URL is kept.
 */
const IMAGE_DATA_URL = /data:image\/[a-z0-9.+_-]+;base64,([A-Za-z0-9+/]+={0,2})/gi;

/**
 * The number of base64 characters that decode to the 18 bytes the image
 * signatures need: WebP's is the longest, 12 bytes from the start.
 */
const SIGNATURE_BASE64_LENGTH = 24;

/** Returns `value` as a record when it is a plain object, or undefined. */
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Checks whether a declared media type is an image's. */
const isImageMimeType = (mimeType: unknown): boolean =>
  typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");

/** Returns `data` when it is a string whose declared media type is an image's, or undefined. */
const readDeclaredImageData = (data: unknown, mimeType: unknown): string | undefined =>
  typeof data === "string" && isImageMimeType(mimeType) ? data : undefined;

/**
 * Returns the blob of an MCP resource when it is an image, or undefined. A
 * resource may leave out its media type, and then the blob's first bytes
 * decide, so a PDF or another file is never taken for an image.
 */
const readResourceImageData = (resource: Readonly<Record<string, unknown>>): string | undefined => {
  const { blob, mimeType } = resource;
  if (typeof blob !== "string") return undefined;
  if (mimeType !== undefined) return readDeclaredImageData(blob, mimeType);
  const start = Buffer.from(blob.slice(0, SIGNATURE_BASE64_LENGTH), "base64");
  return detectImageMimeType(start) === undefined ? undefined : blob;
};

/**
 * Returns the base64 data of the image `value` is, or undefined when it is
 * not one. `value` is replaced whole by the image's reference. Three shapes
 * are an image:
 *
 * - `{ type: "image", source: { type: "base64", data, media_type } }`, the
 *   Messages API's image block, in a `tool_result`'s content and in what a
 *   subagent or an MCP tool repeats of it;
 * - `{ type: "image", data, mimeType }`, MCP's image block, as an MCP tool's
 *   `structuredContent` may hold it;
 * - `{ type: "resource", resource: { blob, mimeType } }`, MCP's embedded
 *   resource.
 *
 * A shape counts only when it is an image's, by its declared media type, so
 * a PDF, an audio clip or another blob is left as it is. An image the
 * controller does not store, such as a BMP, is still uploaded: it is
 * refused and becomes `unavailable`, so its bytes are dropped all the same.
 */
const readImageData = (value: unknown): string | undefined => {
  const record = asRecord(value);
  if (record?.type === "image") {
    const source = asRecord(record.source);
    return source?.type === "base64"
      ? readDeclaredImageData(source.data, source.media_type)
      : readDeclaredImageData(record.data, record.mimeType);
  }
  if (record?.type === "resource") {
    const resource = asRecord(record.resource);
    return resource === undefined ? undefined : readResourceImageData(resource);
  }
  return undefined;
};

/**
 * Returns the base64 data of the image that `record`'s field `key` holds,
 * or undefined when it holds none. Only that field is replaced by the
 * image's reference, and the record's other fields are searched as usual.
 * Two shapes hold an image in a field:
 *
 * - `{ base64, type }`, the `file` of Claude's `Read` of an image;
 * - `{ image_data, media_type }`, a cell output's image in Claude's `Read`
 *   of a notebook.
 */
const readImageFieldData = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  if (key === "base64") return readDeclaredImageData(record.base64, record.type);
  if (key === "image_data") return readDeclaredImageData(record.image_data, record.media_type);
  return undefined;
};

/**
 * Adds the base64 data of every image inside `value`, at any depth, to
 * `found`. Text is searched for data URLs: Claude's `Bash` keeps the image a
 * command printed this way, in its `stdout`. The text stays text, and
 * `scrubImageData` replaces the data in it. Empty data is not added: it
 * holds no bytes to take out, and an empty pattern would scrub between
 * every character.
 */
const findImages = (value: unknown, found: Set<string>): void => {
  if (typeof value === "string") {
    for (const match of value.matchAll(IMAGE_DATA_URL)) found.add(match[1]!);
    return;
  }
  const data = readImageData(value);
  if (data !== undefined) {
    if (data !== "") found.add(data);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) findImages(item, found);
    return;
  }
  const record = asRecord(value);
  if (record === undefined) return;
  for (const [key, field] of Object.entries(record)) {
    const fieldData = readImageFieldData(record, key);
    if (fieldData === undefined) findImages(field, found);
    else if (fieldData !== "") found.add(fieldData);
  }
};

/**
 * Returns `text` with every exact copy of a found image's base64 replaced by
 * a short placeholder naming the image, such as `[image <id>]`. Text holds
 * an image as a data URL, or as a copy no shape holds, for example the JSON
 * of an MCP tool's `structuredContent` repeated as text, which MCP
 * recommends. The agent has already read the text; the copy in the
 * transcript is for people.
 */
const scrubImageData = (text: string, references: ReadonlyMap<string, ToolResultImage>): string => {
  let scrubbed = text;
  for (const [data, reference] of references) {
    if (!scrubbed.includes(data)) continue;
    const placeholder =
      "attachment" in reference ? `[image ${reference.attachment.id}]` : "[image not kept]";
    scrubbed = scrubbed.replaceAll(data, placeholder);
  }
  return scrubbed;
};

/**
 * Returns a copy of `value` in which each image `findImages` found holds its
 * reference from `references`, keyed by the image's data, instead, and every
 * other exact copy of an image's base64, in any text or object key, is
 * scrubbed.
 */
const replaceImages = (
  value: unknown,
  references: ReadonlyMap<string, ToolResultImage>,
): unknown => {
  const data = readImageData(value);
  if (data !== undefined) return references.get(data) ?? value;
  if (typeof value === "string") return scrubImageData(value, references);
  if (Array.isArray(value)) return value.map((item) => replaceImages(item, references));
  const record = asRecord(value);
  if (record === undefined) return value;
  // Two keys that scrub to the same text keep the last field; both held
  // the same image, so nothing a person reads is lost.
  return Object.fromEntries(
    Object.entries(record).map(([key, field]) => {
      const fieldData = readImageFieldData(record, key);
      return [
        scrubImageData(key, references),
        fieldData === undefined
          ? replaceImages(field, references)
          : (references.get(fieldData) ?? field),
      ];
    }),
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
 * `ToolResultImage`. Images are found by shape (see `readImageData` and
 * `readImageFieldData`) in two places: the content of each `tool_result` block, and
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
  const found = new Set<string>();
  for (const block of blocks) if (isToolResultBlock(block)) findImages(block.content, found);
  findImages(sdk.tool_use_result, found);
  if (found.size === 0) return Effect.succeed(sdk);
  return Effect.map(
    Effect.forEach(
      found,
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
