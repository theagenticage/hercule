/**
 * The lightbox: one attached image drawn large, over a scrim. The shelf and
 * the user's bubble open it. It is a chunk of its own, loaded the first time
 * an image is previewed (spec 17 §Performance, rule 6).
 */
import { useEffect, useRef, type JSX } from "react";
import { GlassDialog } from "../glass-dialog";
import "./attachments.css";

/**
 * Renders the image at `index` of the images named `names`, at most 92% of
 * the window's width and 86% of its height, with the caption "name (i/n)"
 * under it. `source` is that image's bytes, or `undefined` while they load.
 *
 * ← and → call `onIndexChange` with the image before or after, and stop at
 * the first and the last. Esc, or a click on the scrim, closes the lightbox
 * and calls `onClose`; the caller then unmounts it.
 */
export function ImageLightbox({
  names,
  index,
  source,
  onIndexChange,
  onClose,
}: {
  readonly names: readonly string[];
  readonly index: number;
  readonly source: Blob | undefined;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // The image is shown through an object URL of its bytes, revoked when
  // another image shows and when the lightbox closes, so only one full-size
  // image is held at a time.
  useEffect(() => {
    const image = imageRef.current;
    if (image === null || source === undefined) return;
    const url = URL.createObjectURL(source);
    image.src = url;
    return () => {
      image.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [source]);
  const name = names[index] ?? "";
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="lightbox"
      label={name}
      onClose={onClose}
      onKeyDown={(event) => {
        const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        const next = index + step;
        if (step === 0 || next < 0 || next >= names.length) return;
        event.preventDefault();
        onIndexChange(next);
      }}
    >
      <div className="lightbox-frame">
        <img ref={imageRef} className="lightbox-image" alt={name} />
      </div>
      <p className="lightbox-caption">
        {name} ({index + 1}/{names.length})
      </p>
    </GlassDialog>
  );
}
