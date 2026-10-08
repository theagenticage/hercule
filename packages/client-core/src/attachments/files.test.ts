import { describe, expect, it } from "vitest";
import { checkImageFile, formatAttachmentSize } from "./files";

describe("formatAttachmentSize", () => {
  it("shows kilobytes below one megabyte, rounded up and never zero", () => {
    expect(formatAttachmentSize(1)).toBe("1 KB");
    expect(formatAttachmentSize(1024)).toBe("1 KB");
    expect(formatAttachmentSize(1025)).toBe("2 KB");
    expect(formatAttachmentSize(1024 * 1024 - 1)).toBe("1024 KB");
  });

  it("shows megabytes with one decimal from one megabyte up", () => {
    expect(formatAttachmentSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatAttachmentSize(2.44 * 1024 * 1024)).toBe("2.4 MB");
    expect(formatAttachmentSize(10 * 1024 * 1024)).toBe("10.0 MB");
  });
});

describe("checkImageFile", () => {
  it("accepts a PNG, JPEG, GIF or WebP image up to 10 MB", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"])
      expect(checkImageFile({ name: "a", type, size: 10 * 1024 * 1024 })).toBeUndefined();
  });

  it("refuses another type, naming the file", () => {
    expect(checkImageFile({ name: "logo.svg", type: "image/svg+xml", size: 100 })).toBe(
      '"logo.svg" is not an image Hercule can send. Attach a PNG, JPEG, GIF or WebP image.',
    );
  });

  it("refuses an empty file and one over 10 MB, naming the file", () => {
    expect(checkImageFile({ name: "blank.png", type: "image/png", size: 0 })).toBe(
      '"blank.png" is empty.',
    );
    expect(
      checkImageFile({ name: "huge.png", type: "image/png", size: 10 * 1024 * 1024 + 1 }),
    ).toBe('"huge.png" is 10.0 MB; an image can be up to 10.0 MB.');
  });
});
