/**
 * The hooks that show a thumbnail: one builds it from a file on the shelf,
 * and one shows any blob in an `<img>`.
 */
import { useCallback, useEffect, useState, type RefCallback } from "react";
import { buildThumbnail, toDevicePixels } from "../../app/thumbnails";

/**
 * Returns a ref for an `<img>` that shows `blob` through an object URL. The
 * URL is revoked when `blob` changes and when the `<img>` unmounts, so the
 * image's bytes are freed with it. With `blob` `undefined`, the ref does
 * nothing.
 */
export function useBlobImageSource(blob: Blob | undefined): RefCallback<HTMLImageElement> {
  return useCallback(
    (image: HTMLImageElement) => {
      if (blob === undefined) return;
      const url = URL.createObjectURL(blob);
      image.src = url;
      return () => {
        image.removeAttribute("src");
        URL.revokeObjectURL(url);
      };
    },
    [blob],
  );
}

/**
 * Returns a thumbnail of the image in `source`, drawn `width` × `height` CSS
 * pixels, as a small WebP blob, or `undefined` while it is being built and
 * when the image cannot be decoded. The thumbnail is not cached: the shelf's
 * images are files on this Mac, and each tile builds its own once.
 *
 * A build still waiting when the component unmounts, or when `source` or the
 * size changes, is cancelled before it decodes the image.
 */
export function useThumbnail(source: Blob, width: number, height: number): Blob | undefined {
  const [built, setBuilt] = useState<{ readonly source: Blob; readonly thumbnail: Blob } | null>(
    null,
  );
  useEffect(() => {
    const cancel = new AbortController();
    buildThumbnail(source, toDevicePixels(width), toDevicePixels(height), cancel.signal).then(
      (thumbnail) => {
        if (!cancel.signal.aborted) setBuilt({ source, thumbnail });
      },
      // An image Chromium cannot decode keeps the tile's empty background.
      () => undefined,
    );
    return () => {
      cancel.abort();
    };
  }, [source, width, height]);
  return built !== null && built.source === source ? built.thumbnail : undefined;
}
