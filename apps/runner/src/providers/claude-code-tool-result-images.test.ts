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

/** Returns the id the fake uploader gives the image whose bytes encode to `data`. */
const buildStoredId = (data: string): string =>
  data === PNG ? "0199e0e7-0000-7000-8000-0000000000c1" : "0199e0e7-0000-7000-8000-0000000000c2";

/** Returns the reference the fake uploader gives the image whose bytes encode to `data`. */
const buildStored = (data: string): ToolResultImage => ({
  type: "image",
  attachment: {
    id: buildStoredId(data),
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

const replace = (
  uploader: AttachmentUploader,
  sdk: SDKMessage,
  signal = new AbortController().signal,
) => Effect.runPromise(replaceToolResultImages(uploader, SESSION, sdk, signal));

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

  it("replaces a notebook cell output's image in the tool's structured output", async () => {
    const uploader = createRecordingUploader();
    const replaced = await replace(
      uploader,
      buildToolResult([buildImageBlock(PNG)], {
        type: "notebook",
        file: {
          filePath: "/work/plot.ipynb",
          cells: [{ outputs: [{ image: { image_data: PNG, media_type: "image/png" } }] }],
        },
      }),
    );

    expect(replaced).toMatchObject({
      tool_use_result: {
        file: { cells: [{ outputs: [{ image: { image_data: buildStored(PNG) } }] }] },
      },
    });
    expect(JSON.stringify(replaced)).not.toContain(PNG);
    expect(uploader.uploads).toEqual([PNG]);
  });

  it("uploads at most four images of one message at once", async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    const uploader: AttachmentUploader = {
      upload: () =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            inFlight += 1;
            mostInFlight = Math.max(mostInFlight, inFlight);
          }),
          () => Effect.as(Effect.sleep("1 millis"), buildStored(PNG)),
          () => Effect.sync(() => (inFlight -= 1)),
        ),
    };
    const images = Array.from({ length: 10 }, (_, i) =>
      buildImageBlock(Buffer.concat([PNG_BYTES, Buffer.from([i])]).toString("base64")),
    );
    await replace(uploader, buildToolResult(images));

    expect(mostInFlight).toBe(4);
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

  it("replaces an image in an MCP tool's structured content, in MCP's own block shape", async () => {
    const uploader = createRecordingUploader();
    const replaced = await replace(
      uploader,
      buildToolResult([buildImageBlock(PNG)], {
        structuredContent: { screenshot: { type: "image", data: PNG, mimeType: "image/png" } },
      }),
    );

    expect(replaced).toMatchObject({
      tool_use_result: { structuredContent: { screenshot: buildStored(PNG) } },
    });
    expect(JSON.stringify(replaced)).not.toContain(PNG);
    expect(uploader.uploads).toEqual([PNG]);
  });

  it("uploads an image only the tool's structured output holds", async () => {
    const uploader = createRecordingUploader();
    const text = { type: "text", text: "took a screenshot" };
    const replaced = await replace(
      uploader,
      buildToolResult([text], {
        structuredContent: { screenshot: { type: "image", data: OTHER, mimeType: "image/png" } },
      }),
    );

    expect(replaced).toMatchObject({
      tool_use_result: { structuredContent: { screenshot: buildStored(OTHER) } },
    });
    expect(readContent(replaced)).toEqual([text]);
    expect(uploader.uploads).toEqual([OTHER]);
  });

  it("uploads each of two different images in the content and the structured output", async () => {
    const uploader = createRecordingUploader();
    const replaced = await replace(
      uploader,
      buildToolResult([buildImageBlock(PNG)], {
        type: "image",
        file: { base64: OTHER, type: "image/png" },
      }),
    );

    expect(readContent(replaced)).toEqual([buildStored(PNG)]);
    expect(replaced).toMatchObject({ tool_use_result: { file: { base64: buildStored(OTHER) } } });
    expect(uploader.uploads.toSorted()).toEqual([PNG, OTHER].toSorted());
  });

  it("replaces an MCP resource that embeds an image, and leaves one that embeds a PDF", async () => {
    const uploader = createRecordingUploader();
    const pdf = {
      type: "resource",
      resource: { uri: "file:///a.pdf", mimeType: "application/pdf", blob: "JVBERi0=" },
    };
    const replaced = await replace(
      uploader,
      buildToolResult([
        { type: "resource", resource: { uri: "file:///a.png", mimeType: "image/png", blob: PNG } },
        pdf,
      ]),
    );

    expect(readContent(replaced)).toEqual([buildStored(PNG), pdf]);
    expect(uploader.uploads).toEqual([PNG]);
  });

  it("leaves what is not an image: a PDF the tool read, and an MCP audio block", async () => {
    const uploader = createRecordingUploader();
    const sdk = buildToolResult([{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" }], {
      type: "pdf",
      file: { base64: "JVBERi0=", type: "application/pdf" },
    });
    const replaced = await replace(uploader, sdk);

    expect(replaced).toBe(sdk);
    expect(uploader.uploads).toEqual([]);
  });

  it("scrubs the data URL a Bash command printed, and keeps stdout as text", async () => {
    const uploader = createRecordingUploader();
    const replaced = await replace(
      uploader,
      buildToolResult([buildImageBlock(PNG)], {
        stdout: `data:image/png;base64,${OTHER}`,
        stderr: "",
        isImage: true,
      }),
    );

    expect(replaced).toMatchObject({
      tool_use_result: {
        stdout: `data:image/png;base64,[image ${buildStoredId(OTHER)}]`,
        isImage: true,
      },
    });
    expect(readContent(replaced)).toEqual([buildStored(PNG)]);
    expect(uploader.uploads.toSorted()).toEqual([PNG, OTHER].toSorted());
  });

  it("finds every data URL inside text, and keeps the text around each", async () => {
    const uploader = createRecordingUploader();
    const replaced = await replace(
      uploader,
      buildToolResult([
        {
          type: "text",
          text: `Before: data:image/png;base64,${PNG}\nand data:image/png;base64,${OTHER}. Saved.`,
        },
      ]),
    );

    expect(readContent(replaced)).toEqual([
      {
        type: "text",
        text: `Before: data:image/png;base64,[image ${buildStoredId(PNG)}]\nand data:image/png;base64,[image ${buildStoredId(OTHER)}]. Saved.`,
      },
    ]);
    expect(uploader.uploads.toSorted()).toEqual([PNG, OTHER].toSorted());
  });

  it("finds an image whose media type is in capitals", async () => {
    const uploader = createRecordingUploader();
    const replaced = await replace(
      uploader,
      buildToolResult([{ type: "image", data: PNG, mimeType: "IMAGE/PNG" }]),
    );

    expect(readContent(replaced)).toEqual([buildStored(PNG)]);
  });

  it("scrubs an image's base64 from an object key", async () => {
    const uploader = createRecordingUploader();
    const replaced = await replace(
      uploader,
      buildToolResult([buildImageBlock(PNG)], { [PNG]: "screenshot" }),
    );

    expect(replaced).toMatchObject({
      tool_use_result: { [`[image ${buildStoredId(PNG)}]`]: "screenshot" },
    });
    expect(JSON.stringify(replaced)).not.toContain(PNG);
  });

  it("leaves an image block with empty data as it is, and scrubs no text for it", async () => {
    const uploader = createRecordingUploader();
    const sdk = buildToolResult([
      { type: "image", data: "", mimeType: "image/png" },
      { type: "text", text: "done" },
    ]);
    const replaced = await replace(uploader, sdk);

    expect(replaced).toBe(sdk);
    expect(uploader.uploads).toEqual([]);
  });

  it("scrubs a copy of an image no shape holds, such as structured content repeated as text", async () => {
    const uploader = createRecordingUploader();
    const screenshot = { type: "image", data: PNG, mimeType: "image/png" };
    const replaced = await replace(
      uploader,
      buildToolResult([{ type: "text", text: JSON.stringify({ screenshot }) }], {
        structuredContent: { screenshot },
      }),
    );

    expect(readContent(replaced)).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          screenshot: { ...screenshot, data: `[image ${buildStoredId(PNG)}]` },
        }),
      },
    ]);
    expect(JSON.stringify(replaced)).not.toContain(PNG);
  });

  it("names an image that was not kept in the placeholder that scrubs it", async () => {
    const unavailable: ToolResultImage = {
      type: "image",
      unavailable: "The image could not be kept.",
    };
    const replaced = await replace(
      { upload: () => Effect.succeed(unavailable) },
      buildToolResult([buildImageBlock(PNG), { type: "text", text: `copy: ${PNG}` }]),
    );

    expect(readContent(replaced)).toEqual([
      unavailable,
      { type: "text", text: "copy: [image not kept]" },
    ]);
  });

  it("tells an image from a PDF by its first bytes when a resource declares no media type", async () => {
    const uploader = createRecordingUploader();
    const pdf = { type: "resource", resource: { uri: "file:///a.pdf", blob: "JVBERi0xLjcK" } };
    const replaced = await replace(
      uploader,
      buildToolResult([{ type: "resource", resource: { uri: "file:///a.png", blob: PNG } }, pdf]),
    );

    expect(readContent(replaced)).toEqual([buildStored(PNG), pdf]);
    expect(uploader.uploads).toEqual([PNG]);
  });

  it("keeps searching a record after an image in one of its fields", async () => {
    const uploader = createRecordingUploader();
    const replaced = await replace(
      uploader,
      buildToolResult([buildImageBlock(PNG)], {
        type: "image",
        file: {
          base64: PNG,
          type: "image/png",
          thumbnail: { image_data: OTHER, media_type: "image/png" },
        },
      }),
    );

    expect(replaced).toMatchObject({
      tool_use_result: {
        file: { base64: buildStored(PNG), thumbnail: { image_data: buildStored(OTHER) } },
      },
    });
    expect(JSON.stringify(replaced)).not.toContain(OTHER);
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
      buildToolResult([buildImageBlock(PNG)], {
        type: "image",
        file: { base64: PNG, type: "image/png" },
      }),
    );

    expect(readContent(replaced)).toEqual([unavailable]);
    expect(JSON.stringify(replaced)).not.toContain(PNG);
  });

  it("starts no more uploads once the session stops, and keeps none of the bytes", async () => {
    const stopping = new AbortController();
    const started: Array<string> = [];
    const uploader: AttachmentUploader = {
      upload: (_sessionId, bytes) =>
        Effect.sync(() => {
          started.push(Buffer.from(bytes).toString("base64"));
          // The session stops while the first uploads are in progress.
          stopping.abort();
          return buildStored(PNG);
        }),
    };
    const images = Array.from({ length: 10 }, (_, i) =>
      Buffer.concat([PNG_BYTES, Buffer.from([i])]).toString("base64"),
    );
    const replaced = await replace(
      uploader,
      buildToolResult(images.map(buildImageBlock)),
      stopping.signal,
    );

    expect(started.length).toBeLessThanOrEqual(4);
    expect(readContent(replaced)).toContainEqual({
      type: "image",
      unavailable: "The session stopped before the image was kept.",
    });
    for (const data of images) expect(JSON.stringify(replaced)).not.toContain(data);
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
