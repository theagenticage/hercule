/**
 * Tests the thumbnail build's cancellation: a build cancelled while it waits
 * in the queue never decodes its image. jsdom has no `createImageBitmap`, so
 * the test stands one in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildThumbnail } from "./thumbnails";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("building a thumbnail", () => {
  it("decodes nothing when it is cancelled before its turn", async () => {
    const decode = vi.fn(() => Promise.reject(new Error("not an image")));
    vi.stubGlobal("createImageBitmap", decode);
    const cancel = new AbortController();

    const built = buildThumbnail(new Blob(["x"]), 64, 64, cancel.signal);
    cancel.abort();

    await expect(built).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });
});
