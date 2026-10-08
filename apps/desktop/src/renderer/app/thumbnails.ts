/**
 * Small pictures of images, built at the size they are drawn at.
 *
 * An `<img>` with an image's full bytes makes Chromium decode the whole
 * image: a 4K screenshot is about 33 MB of pixels, kept for as long as the
 * element shows. Ten of them on a composer's shelf would cost the renderer
 * more than its whole memory budget (spec 17 §Performance). So a thumbnail
 * is decoded once, cropped and scaled to its box in device pixels, and
 * encoded again as a small WebP of a few kilobytes.
 */

/**
 * The thumbnails being built, one after the other. Each one decodes its
 * image at full size for a moment, so building them one at a time keeps the
 * peak to one full-size image, however many are attached at once.
 */
let buildQueue: Promise<unknown> = Promise.resolve();

/**
 * Builds a thumbnail of the image in `source`, `width` × `height` device
 * pixels, cropped to fill that box as CSS `object-fit: cover` does, and
 * returns it as a WebP blob.
 *
 * The build waits for the thumbnails queued before it. Fails with the
 * signal's reason when `signal` is aborted before the image is decoded, so a
 * thumbnail nobody shows any more costs no full decode. Fails when the bytes
 * are not an image Chromium can decode.
 */
export const buildThumbnail = (
  source: Blob,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<Blob> => {
  const built = buildQueue.then(async () => {
    signal.throwIfAborted();
    const full = await createImageBitmap(source);
    try {
      const scale = Math.max(width / full.width, height / full.height);
      const cropWidth = Math.min(full.width, width / scale);
      const cropHeight = Math.min(full.height, height / scale);
      const small = await createImageBitmap(
        full,
        (full.width - cropWidth) / 2,
        (full.height - cropHeight) / 2,
        cropWidth,
        cropHeight,
        { resizeWidth: width, resizeHeight: height, resizeQuality: "high" },
      );
      const canvas = new OffscreenCanvas(width, height);
      // A bitmap renderer takes the bitmap over without copying its pixels.
      canvas.getContext("bitmaprenderer")!.transferFromImageBitmap(small);
      return await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
    } finally {
      full.close();
    }
  });
  // A failed or cancelled thumbnail must not stop the ones queued after it.
  buildQueue = built.catch(() => undefined);
  return built;
};

/** Returns `size` CSS pixels in this screen's device pixels, the size a thumbnail is built at. */
export const toDevicePixels = (size: number): number => Math.round(size * window.devicePixelRatio);
