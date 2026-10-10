import { describe, expect, it } from "vitest";
import { detectImageMimeType } from "./image-signatures";

const bytesOf = (...values: ReadonlyArray<number>) => new Uint8Array(values);
const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));

describe("detectImageMimeType", () => {
  it("recognises each accepted image type by its first bytes", () => {
    expect(detectImageMimeType(bytesOf(0x89, ...ascii("PNG\r\n\x1a\n"), 0))).toBe("image/png");
    expect(detectImageMimeType(bytesOf(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(detectImageMimeType(bytesOf(...ascii("GIF89a")))).toBe("image/gif");
    expect(detectImageMimeType(bytesOf(...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBPVP8 ")))).toBe(
      "image/webp",
    );
  });

  it("returns undefined for anything else, including a RIFF file that is not WebP", () => {
    expect(detectImageMimeType(bytesOf(...ascii("%PDF-1.7")))).toBeUndefined();
    expect(
      detectImageMimeType(bytesOf(...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE"))),
    ).toBeUndefined();
    expect(detectImageMimeType(bytesOf(0x89, 0x50))).toBeUndefined();
    expect(detectImageMimeType(new Uint8Array())).toBeUndefined();
  });
});
