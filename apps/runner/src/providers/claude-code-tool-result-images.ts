/**
 * Takes the images out of the tool results in a Claude SDK message, before
 * the normalizer sees it, so no event carries an image's bytes.
 *
 * A Claude `Read` of a PNG returns the image twice: as an image block with
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

/** An image block with inline base64 data, as the Messages API writes it in a tool result. */
interface Base64ImageBlock {
  readonly type: "image";
  readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string };
}

/** The reason an image too large for the controller is not kept. */
export const IMAGE_TOO_LARGE = "The image is larger than 10 MB, so it was not kept.";

/** Checks whether a content block is an image with inline base64 data. */
const isBase64ImageBlock = (block: unknown): block is Base64ImageBlock => {
  if (typeof block !== "object" || block === null) return false;
  const { type, source } = block as { readonly type?: unknown; readonly source?: unknown };
  if (type !== "image" || typeof source !== "object" || source === null) return false;
  const { type: sourceType, data, media_type } = source as Record<string, unknown>;
  return sourceType === "base64" && typeof data === "string" && typeof media_type === "string";
};

/** Returns the content array of a `tool_result` block, or undefined for any other block. */
const readToolResultContent = (block: unknown): ReadonlyArray<unknown> | undefined => {
  if (typeof block !== "object" || block === null) return undefined;
  const { type, content } = block as { readonly type?: unknown; readonly content?: unknown };
  return type === "tool_result" && Array.isArray(content) ? content : undefined;
};

/**
 * Returns the image blocks inside the tool results of a user message, in the
 * order they appear. Returns an empty list for every other message.
 */
const findToolResultImages = (sdk: SDKMessage): ReadonlyArray<Base64ImageBlock> => {
  if (sdk.type !== "user" || !Array.isArray(sdk.message.content)) return [];
  return sdk.message.content.flatMap(
    (block) => readToolResultContent(block)?.filter(isBase64ImageBlock) ?? [],
  );
};

/**
 * Returns the number of bytes base64 `data` decodes to, without decoding it,
 * so an image too large to keep is refused before it is copied in memory.
 */
const computeDecodedSize = (data: string): number => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
};

/**
 * Uploads one image and returns its reference. An image larger than
 * `MAX_ATTACHMENT_BYTES` is not uploaded: the controller would refuse it.
 */
const uploadImage = (
  uploader: AttachmentUploader,
  sessionId: string,
  image: Base64ImageBlock,
): Effect.Effect<ToolResultImage> => {
  if (computeDecodedSize(image.source.data) > MAX_ATTACHMENT_BYTES) {
    return Effect.succeed({ type: "image", unavailable: IMAGE_TOO_LARGE });
  }
  return uploader.upload(sessionId, Buffer.from(image.source.data, "base64"));
};

/**
 * Returns a copy of `value` in which every `base64` field whose string is the
 * data of an uploaded image holds that image's reference instead. Other
 * base64, such as a PDF's, is left as it is.
 */
const replaceBase64Fields = (
  value: unknown,
  references: ReadonlyMap<string, ToolResultImage>,
): unknown => {
  if (Array.isArray(value)) return value.map((item) => replaceBase64Fields(item, references));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => {
      const reference =
        key === "base64" && typeof field === "string" ? references.get(field) : undefined;
      return [key, reference ?? replaceBase64Fields(field, references)];
    }),
  );
};

/**
 * Returns the message with each image in its tool results replaced by a
 * `ToolResultImage`, in the tool result's content and in `tool_use_result`
 * alike. Each distinct image is uploaded once, and the uploads of one
 * message run in parallel. A message with no such image is returned as the
 * same object, with no work done, because every SDK message passes through
 * here. Never fails: an image that cannot be kept becomes `unavailable`, and
 * its bytes are dropped all the same.
 */
export const replaceToolResultImages = (
  uploader: AttachmentUploader,
  sessionId: string,
  sdk: SDKMessage,
): Effect.Effect<SDKMessage> => {
  const images = findToolResultImages(sdk);
  if (images.length === 0 || sdk.type !== "user") return Effect.succeed(sdk);
  const distinct = new Map(images.map((image) => [image.source.data, image]));
  return Effect.map(
    Effect.forEach(
      distinct,
      ([data, image]) =>
        Effect.map(
          uploadImage(uploader, sessionId, image),
          (reference) => [data, reference] as const,
        ),
      { concurrency: "unbounded" },
    ),
    (entries) => {
      const references = new Map(entries);
      const content = (sdk.message.content as ReadonlyArray<unknown>).map((block) => {
        const blocks = readToolResultContent(block);
        if (blocks === undefined) return block;
        return {
          ...(block as object),
          content: blocks.map((inner) =>
            isBase64ImageBlock(inner) ? references.get(inner.source.data) : inner,
          ),
        };
      });
      // The SDK's types have no reference block, so the copy is cast back to
      // an SDK message. The normalizer passes a tool result's content array
      // through untouched, and the event's `detail` is plain JSON.
      return {
        ...sdk,
        message: { ...sdk.message, content },
        ...(sdk.tool_use_result === undefined
          ? {}
          : { tool_use_result: replaceBase64Fields(sdk.tool_use_result, references) }),
      } as SDKMessage;
    },
  );
};
