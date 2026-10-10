import { lazy, Suspense, useState, type JSX } from "react";
import type { ToolResultImage } from "@hercule/contract";
import { useAttachmentContent, useAttachmentThumbnails } from "./attachment-contents";
import { IMAGE_TILE_HEIGHT, IMAGE_TILE_WIDTH, ImageTile, type TileImage } from "./image-tile";
import "./attachments.css";

// The lightbox is a chunk of its own, loaded the first time an image is
// previewed (spec 17 §Performance, rule 6).
const ImageLightbox = lazy(() =>
  import("./image-lightbox").then((module) => ({ default: module.ImageLightbox })),
);

/**
 * Returns the name a tool's stored image is shown with. A tool's image has
 * no file name, so it is named by its place among the step's stored images:
 * "Image 1", "Image 2", and so on.
 */
const nameToolImage = (index: number): string => `Image ${String(index + 1)}`;

/**
 * Renders the images a tool returned, under its step, and the lightbox while
 * one of them is open. `images` is what `readToolResultImages` read from the
 * step's detail.
 *
 * Each stored image is a tile showing its thumbnail, built when the tile
 * first draws, so a step that is never drawn reads nothing. A tile shows its
 * empty background until the thumbnail is ready, or when the image cannot be
 * read. The lightbox reads the open image at full size.
 */
export function ToolResultImages({
  images,
}: {
  readonly images: readonly ToolResultImage[];
}): JSX.Element {
  const stored = images.flatMap((image) => ("attachment" in image ? [image.attachment] : []));
  const unavailable = images.flatMap((image) =>
    "unavailable" in image ? [image.unavailable] : [],
  );
  const thumbnails = useAttachmentThumbnails(stored, IMAGE_TILE_WIDTH, IMAGE_TILE_HEIGHT);
  const [open, setOpen] = useState<number | null>(null);
  const content = useAttachmentContent(open === null ? undefined : stored[open]);

  return (
    <>
      <ToolResultImageList
        images={stored.map((image, index) => ({
          key: image.id,
          name: nameToolImage(index),
          thumbnail: thumbnails[index],
        }))}
        unavailable={unavailable}
        onOpen={setOpen}
      />
      {open === null ? null : (
        <Suspense fallback={null}>
          <ImageLightbox
            names={stored.map((_, index) => nameToolImage(index))}
            index={open}
            source={content}
            onIndexChange={setOpen}
            onClose={() => {
              setOpen(null);
            }}
          />
        </Suspense>
      )}
    </>
  );
}

/**
 * Renders a tool's images: the stored ones as tiles, as many 210px columns
 * as fit, and under them one quiet line per image that could not be kept:
 * the reason the runner gave, a whole sentence written for the user, such
 * as "The image is larger than 10 MB, so it was not kept." A click on a
 * tile calls `onOpen` with its index in `images`.
 *
 * The lines come after the tiles, so an unavailable image does not keep its
 * place among the stored ones; a reason is a sentence and does not fit in a
 * tile.
 */
export function ToolResultImageList({
  images,
  unavailable,
  onOpen,
}: {
  readonly images: readonly TileImage[];
  readonly unavailable: readonly string[];
  readonly onOpen: (index: number) => void;
}): JSX.Element {
  return (
    <div className="tool-images">
      {images.length === 0 ? null : (
        <div className="tool-image-tiles">
          {images.map((image, index) => (
            <ImageTile
              key={image.key}
              name={image.name}
              thumbnail={image.thumbnail}
              onOpen={() => {
                onOpen(index);
              }}
            />
          ))}
        </div>
      )}
      {unavailable.map((reason, index) => (
        <p key={index} className="tool-image-unavailable">
          {reason}
        </p>
      ))}
    </div>
  );
}
