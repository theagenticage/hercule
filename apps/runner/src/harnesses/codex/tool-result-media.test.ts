import { describe, expect, it } from "vitest";
import type { NotificationFrame } from "./rpc";
import { removeMediaBytes } from "./tool-result-media";

const IMAGE = Buffer.from(
  "not really a picture, but long enough to count as bytes, ".repeat(3),
).toString("base64");
const AUDIO = Buffer.from(
  "not really a sound, but long enough to count as bytes, ".repeat(3),
).toString("base64");
const BLOB = Buffer.from(
  "not really a document, but long enough to count as bytes, ".repeat(3),
).toString("base64");

const NOT_KEPT = "[bytes not kept]";

const buildCall = (result: unknown, id = "call-1") => ({
  type: "mcpToolCall",
  id,
  server: "tools",
  tool: "sentry__get_snapshot_image",
  status: "completed",
  arguments: {},
  result,
  error: null,
});

const buildItemFrame = (item: unknown): NotificationFrame => ({
  method: "item/completed",
  params: { threadId: "thread", turnId: "turn", item },
});

const buildTurnFrame = (items: ReadonlyArray<unknown>): NotificationFrame => ({
  method: "turn/completed",
  params: { threadId: "thread", turn: { id: "turn", items, status: "completed" } },
});

/** Returns the frame's call results: that of `params.item`, or those of `params.turn.items`. */
const readResults = (frame: NotificationFrame): ReadonlyArray<unknown> => {
  const params = frame.params as {
    item?: { result?: unknown };
    turn?: { items: ReadonlyArray<{ result?: unknown }> };
  };
  return params.turn === undefined ? [params.item?.result] : params.turn.items.map((i) => i.result);
};

/** Builds a new result each time, because removing media changes the result it is given. */
const buildImageResult = () => ({
  content: [
    { type: "text", text: "Snapshot of the issue" },
    { type: "image", data: IMAGE, mimeType: "image/png" },
    { type: "text", text: "Taken just now" },
  ],
  structuredContent: null,
  _meta: null,
});

describe("removing the media bytes of a notification frame", () => {
  describe.each([
    ["an item frame", (result: unknown) => buildItemFrame(buildCall(result))],
    ["a turn frame", (result: unknown) => buildTurnFrame([buildCall(result)])],
  ])("in %s", (_name, buildFrame) => {
    it("replaces an image block by an unavailable image, in its place, and keeps the text", () => {
      const frame = buildFrame(buildImageResult());

      removeMediaBytes(frame);
      const notKeptNotice: unknown = expect.stringContaining("does not keep");

      expect(readResults(frame)).toEqual([
        {
          ...buildImageResult(),
          content: [
            { type: "text", text: "Snapshot of the issue" },
            { type: "image", unavailable: notKeptNotice },
            { type: "text", text: "Taken just now" },
          ],
        },
      ]);
      expect(JSON.stringify(frame)).not.toContain(IMAGE);
    });

    it("replaces the bytes of audio and of an embedded resource, and keeps the rest of the block", () => {
      const frame = buildFrame({
        content: [
          { type: "text", text: "Recorded it" },
          { type: "audio", data: AUDIO, mimeType: "audio/wav" },
          {
            type: "resource",
            resource: { uri: "file:///report.pdf", mimeType: "application/pdf", blob: BLOB },
          },
        ],
        structuredContent: null,
        _meta: null,
      });

      removeMediaBytes(frame);

      expect(readResults(frame)).toEqual([
        {
          content: [
            { type: "text", text: "Recorded it" },
            { type: "audio", data: NOT_KEPT, mimeType: "audio/wav" },
            {
              type: "resource",
              resource: { uri: "file:///report.pdf", mimeType: "application/pdf", blob: NOT_KEPT },
            },
          ],
          structuredContent: null,
          _meta: null,
        },
      ]);
    });

    it("replaces every other copy of the bytes, in values, in keys and inside longer text", () => {
      const frame = buildFrame({
        ...buildImageResult(),
        structuredContent: { screenshot: IMAGE, [IMAGE]: "keyed by the image" },
        _meta: { preview: `data:image/png;base64,${IMAGE}`, [`key-${IMAGE}`]: ["x", IMAGE] },
      });

      removeMediaBytes(frame);

      expect(readResults(frame)).toMatchObject([
        {
          structuredContent: { screenshot: NOT_KEPT, [NOT_KEPT]: "keyed by the image" },
          _meta: {
            preview: `data:image/png;base64,${NOT_KEPT}`,
            [`key-${NOT_KEPT}`]: ["x", NOT_KEPT],
          },
        },
      ]);
      expect(JSON.stringify(frame)).not.toContain(IMAGE);
    });

    it.each([
      ["a short word", "Completed"],
      ["text that is long but not base64", "Snapshot of the issue, taken just now by the tool"],
      ["base64 shorter than any real payload", "aGVsbG8gd29ybGQ="],
    ])("does not scrub a text that a server reuses as an image's data: %s", (_name, text) => {
      const frame = buildFrame({
        content: [
          { type: "text", text },
          { type: "image", data: text, mimeType: "image/png" },
        ],
        structuredContent: { summary: text },
        _meta: null,
      });

      removeMediaBytes(frame);

      expect(readResults(frame)).toMatchObject([
        {
          content: [{ type: "text", text }, { type: "image" }],
          structuredContent: { summary: text },
        },
      ]);
    });

    it("numbers a key that collides with another after the rewrite, so no field is lost", () => {
      const other = Buffer.from(
        "another picture, long enough too, to count as bytes".repeat(3),
      ).toString("base64");
      const frame = buildFrame({
        content: [
          { type: "image", data: IMAGE, mimeType: "image/png" },
          { type: "image", data: other, mimeType: "image/png" },
        ],
        structuredContent: { [IMAGE]: "first", [other]: "second" },
        _meta: null,
      });

      removeMediaBytes(frame);

      expect(readResults(frame)).toMatchObject([
        { structuredContent: { [NOT_KEPT]: "first", [`${NOT_KEPT} (2)`]: "second" } },
      ]);
    });

    it("leaves a result with no media as it was", () => {
      const textOnly = {
        content: [{ type: "text", text: "3 issues found" }],
        structuredContent: { count: 3 },
        _meta: null,
      };
      const frame = buildFrame(textOnly);

      removeMediaBytes(frame);

      expect(readResults(frame)).toEqual([textOnly]);
    });

    it("drops a result too deeply nested to walk, bytes and all", () => {
      let deep: unknown = IMAGE;
      for (let level = 0; level < 30_000; level += 1) deep = [deep];
      const frame = buildFrame({ ...buildImageResult(), structuredContent: deep });

      removeMediaBytes(frame);

      expect(readResults(frame)).toEqual([undefined]);
    });
  });

  it("removes the result of a generated image", () => {
    const frame = buildItemFrame({
      type: "imageGeneration",
      id: "image-1",
      status: "completed",
      revisedPrompt: "a cat",
      result: IMAGE,
    });

    removeMediaBytes(frame);

    expect(frame.params).toMatchObject({ item: { revisedPrompt: "a cat" } });
    expect(JSON.stringify(frame)).not.toContain(IMAGE);
  });

  it("leaves a frame with no item, and an item of another kind, as they were", () => {
    const status = { method: "thread/status/changed", params: { status: "idle" } };
    const message = buildItemFrame({ type: "agentMessage", id: "m", text: IMAGE });

    removeMediaBytes(status);
    removeMediaBytes(message);

    expect(status.params).toEqual({ status: "idle" });
    expect(JSON.stringify(message)).toContain(IMAGE);
  });
});
