/**
 * Takes the images out of the tool results in a Claude SDK message, before
 * the normalizer sees it, so no event carries an image's bytes. The images
 * are found and replaced by `replaceImagesInValues`, which Codex's adapter
 * uses too.
 */
import * as Effect from "effect/Effect";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AttachmentUploader } from "../attachments";
import { asRecord, replaceImagesInValues } from "./tool-result-images";

/** Checks whether a content block of a user message is a `tool_result`. */
const isToolResultBlock = (block: unknown): block is { readonly content?: unknown } =>
  asRecord(block)?.type === "tool_result";

/**
 * Returns the message with each image in its tool results replaced by a
 * `ToolResultImage`. Images are found in two places: the content of each
 * `tool_result` block, and `tool_use_result`, the tool's structured output.
 * The user's own images in a prompt are not in either, so they are never
 * taken for a tool's.
 *
 * A message with no such image is returned as the same object, with no work
 * done. Never fails: see `replaceImagesInValues`.
 */
export const replaceToolResultImages = (
  uploader: AttachmentUploader,
  sessionId: string,
  sdk: SDKMessage,
  signal: AbortSignal,
): Effect.Effect<SDKMessage> => {
  if (sdk.type !== "user" || !Array.isArray(sdk.message.content)) return Effect.succeed(sdk);
  const blocks: ReadonlyArray<unknown> = sdk.message.content;
  const results = blocks.filter(isToolResultBlock);
  // The tool results' contents, then the structured output as the last value.
  const values = [...results.map((block) => block.content), sdk.tool_use_result];
  return Effect.map(replaceImagesInValues(uploader, sessionId, values, signal), (replaced) => {
    if (replaced === values) return sdk;
    const contents = new Map(results.map((block, index) => [block, replaced[index]]));
    const content = blocks.map((block) =>
      isToolResultBlock(block) ? { ...block, content: contents.get(block) } : block,
    );
    // The SDK's types have no reference block, so the copy is cast back to
    // an SDK message. The normalizer passes a tool result's content array
    // through untouched, and the event's `detail` is plain JSON.
    return {
      ...sdk,
      message: { ...sdk.message, content },
      ...(sdk.tool_use_result === undefined ? {} : { tool_use_result: replaced.at(-1) }),
    } as SDKMessage;
  });
};
