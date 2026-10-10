/**
 * Tests `readToolResultImages(content)`, which returns the images a tool
 * returned, as references, from its step's result content.
 */
import { describe, expect, it } from "vitest";
import { readToolResultImages } from "./tool-result-images";

const STORED = {
  type: "image",
  attachment: {
    id: "01a06d02-7700-7000-8000-0000000000b1",
    mimeType: "image/png",
    sizeBytes: 2048,
  },
} as const;

const UNAVAILABLE = {
  type: "image",
  unavailable: "The image is larger than 10 MB, so it was not kept.",
} as const;

describe("readToolResultImages", () => {
  it("returns the stored and the unavailable images in the order the tool returned them", () => {
    const content = [{ type: "text", text: "Took two screenshots." }, UNAVAILABLE, STORED];

    expect(readToolResultImages(content)).toEqual([UNAVAILABLE, STORED]);
  });

  it("skips an image block that is not a reference, such as one with its bytes inline", () => {
    const content = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
      },
      { type: "image", attachment: { ...STORED.attachment, mimeType: "image/tiff" } },
      STORED,
    ];

    expect(readToolResultImages(content)).toEqual([STORED]);
  });

  it("returns no images when the content is not a list of blocks", () => {
    expect(readToolResultImages("Done.")).toEqual([]);
    expect(readToolResultImages({ type: "image" })).toEqual([]);
    expect(readToolResultImages(undefined)).toEqual([]);
  });
});
