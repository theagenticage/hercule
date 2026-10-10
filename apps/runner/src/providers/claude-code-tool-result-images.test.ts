/**
 * Tests how the images in a Claude tool result are replaced by references,
 * with a fake uploader that records what it was given.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { MAX_ATTACHMENT_BYTES, type ToolResultImage } from "@hercule/protocol";
import type { AttachmentUploader } from "../attachments";
import { replaceToolResultImages } from "./claude-code-tool-result-images";
import { PNG_BYTES } from "./testing";

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const PNG = PNG_BYTES.toString("base64");
/** A second, different image: the same PNG with one extra byte at the end. */
const OTHER = Buffer.concat([PNG_BYTES, Buffer.from([0])]).toString("base64");

/** Returns the reference the fake uploader gives the image whose bytes encode to `data`. */
const buildStored = (data: string): ToolResultImage => ({
  type: "image",
  attachment: {
    id:
      data === PNG
        ? "0199e0e7-0000-7000-8000-0000000000c1"
        : "0199e0e7-0000-7000-8000-0000000000c2",
    mimeType: "image/png",
    sizeBytes: Buffer.from(data, "base64").length,
  },
});

/** Creates an uploader that stores every image and records each upload's base64. */
const createRecordingUploader = (): AttachmentUploader & { readonly uploads: Array<string> } => {
  const uploads: Array<string> = [];
  return {
    uploads,
    upload: (sessionId, bytes) =>
      Effect.sync(() => {
        expect(sessionId).toBe(SESSION);
        const data = Buffer.from(bytes).toString("base64");
        uploads.push(data);
        return buildStored(data);
      }),
  };
};

const buildImageBlock = (data: string) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
});

/** Builds a user message with one tool result holding `content`. */
const buildToolResult = (content: ReadonlyArray<unknown>, toolUseResult?: unknown): SDKMessage =>
  ({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_read", content }],
    },
    ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
    parent_tool_use_id: null,
    session_id: "native",
  }) as SDKMessage;

const replace = (uploader: AttachmentUploader, sdk: SDKMessage) =>
  Effect.runPromise(replaceToolResultImages(uploader, SESSION, sdk));

/** Returns the content of the first tool result in a replaced message. */
const readContent = (sdk: SDKMessage): unknown =>
  (sdk as { message: { content: Array<{ content: unknown }> } }).message.content[0]?.content;

describe("replacing the images in a tool result", () => {
  it("replaces each image block with the reference to the uploaded image", async () => {
    const uploader = createRecordingUploader();
    const text = { type: "text", text: "the screenshot" };
    const replaced = await replace(
      uploader,
      buildToolResult([text, buildImageBlock(PNG), buildImageBlock(OTHER)]),
    );

    expect(readContent(replaced)).toEqual([text, buildStored(PNG), buildStored(OTHER)]);
    expect(uploader.uploads.toSorted()).toEqual([PNG, OTHER].toSorted());
  });

  it("replaces the image's base64 in the tool's structured output, uploading it only once", async () => {
    const uploader = createRecordingUploader();
    const replaced = await replace(
      uploader,
      buildToolResult([buildImageBlock(PNG), buildImageBlock(PNG)], {
        type: "image",
        file: { base64: PNG, type: "image/png", originalSize: 70 },
        // Base64 of something that is not one of the images, such as a PDF, stays.
        documents: [{ base64: "JVBERi0=" }],
      }),
    );

    expect(replaced).toMatchObject({
      tool_use_result: {
        type: "image",
        file: { base64: buildStored(PNG), type: "image/png", originalSize: 70 },
        documents: [{ base64: "JVBERi0=" }],
      },
    });
    expect(readContent(replaced)).toEqual([buildStored(PNG), buildStored(PNG)]);
    expect(uploader.uploads).toEqual([PNG]);
  });

  it("replaces an image block the tool's structured output repeats, as an MCP tool's does", async () => {
    const uploader = createRecordingUploader();
    const text = { type: "text", text: "the screenshot" };
    const replaced = await replace(
      uploader,
      buildToolResult([text, buildImageBlock(PNG)], {
        content: [text, buildImageBlock(PNG)],
      }),
    );

    expect(replaced).toMatchObject({ tool_use_result: { content: [text, buildStored(PNG)] } });
    expect(JSON.stringify(replaced)).not.toContain(PNG);
    expect(uploader.uploads).toEqual([PNG]);
  });

  it("replaces image blocks in a structured output that is an array of blocks", async () => {
    const uploader = createRecordingUploader();
    const replaced = await replace(
      uploader,
      buildToolResult(
        [buildImageBlock(PNG), buildImageBlock(OTHER)],
        [buildImageBlock(OTHER), buildImageBlock(PNG)],
      ),
    );

    expect(replaced).toMatchObject({ tool_use_result: [buildStored(OTHER), buildStored(PNG)] });
    expect(JSON.stringify(replaced)).not.toContain(PNG);
  });

  it("keeps no image larger than the controller stores, and does not upload it", async () => {
    const uploader = createRecordingUploader();
    const large = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");
    const replaced = await replace(uploader, buildToolResult([buildImageBlock(large)]));

    expect(readContent(replaced)).toEqual([
      { type: "image", unavailable: expect.stringContaining("larger than 10 MB") as string },
    ]);
    expect(uploader.uploads).toEqual([]);
  });

  it("uploads an image of exactly the largest size the controller stores", async () => {
    const uploader = createRecordingUploader();
    const largest = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64");
    await replace(uploader, buildToolResult([buildImageBlock(largest)]));

    expect(uploader.uploads).toHaveLength(1);
  });

  it("keeps what the uploader returns for an image it could not keep, and none of the bytes", async () => {
    const unavailable: ToolResultImage = {
      type: "image",
      unavailable: "The image could not be kept: the controller could not be reached",
    };
    const replaced = await replace(
      { upload: () => Effect.succeed(unavailable) },
      buildToolResult([buildImageBlock(PNG)], { type: "image", file: { base64: PNG } }),
    );

    expect(readContent(replaced)).toEqual([unavailable]);
    expect(JSON.stringify(replaced)).not.toContain(PNG);
  });

  it("returns a message with no image in a tool result as the same object, without uploading", async () => {
    const uploader = createRecordingUploader();
    const messages: ReadonlyArray<SDKMessage> = [
      buildToolResult([{ type: "text", text: "no image here" }]),
      {
        type: "user",
        message: { role: "user", content: "a plain prompt" },
        parent_tool_use_id: null,
        session_id: "native",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [buildImageBlock(PNG)] },
        parent_tool_use_id: null,
        session_id: "native",
      } as unknown as SDKMessage,
    ];

    for (const sdk of messages) expect(await replace(uploader, sdk)).toBe(sdk);
    expect(uploader.uploads).toEqual([]);
  });
});
