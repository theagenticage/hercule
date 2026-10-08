import { useCallback, type RefCallback } from "react";

/**
 * Returns a ref callback that shows `blob` in the `<img>` it is attached to,
 * through an object URL. The URL is revoked when the blob changes or the
 * image leaves the page, so an image shown from memory never keeps its bytes
 * alive after it is gone. With no blob, the image has no `src`.
 *
 * A ref callback rather than state: the URL is made and revoked with the
 * element itself, so no render ever holds a URL that is already revoked, and
 * a remount makes a fresh one.
 */
export function useBlobImageSource(blob: Blob | null | undefined): RefCallback<HTMLImageElement> {
  return useCallback(
    (image: HTMLImageElement | null) => {
      if (image === null || blob === null || blob === undefined) return;
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
