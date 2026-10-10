import type { JSX } from "react";
import { useBlobImageSource } from "./thumbnail";
import "./attachments.css";

/**
 * The size an image tile is drawn at, in CSS pixels: 210 wide, at 4:3. The
 * grids that hold tiles size their columns to match.
 */
export const IMAGE_TILE_WIDTH = 210;
export const IMAGE_TILE_HEIGHT = 158;

/** One image as a grid of tiles draws it. */
export interface TileImage {
  /** The attachment's id. */
  readonly key: string;
  readonly name: string;
  /** The image at the tile's size, or `undefined` while it is built. */
  readonly thumbnail: Blob | undefined;
}

/**
 * Renders one image as a button that calls `onOpen` to show it large in the
 * lightbox. The tile fills the width of its grid column, at 4:3. `name` is
 * the button's label and tooltip. `thumbnail` is the image at the tile's
 * size, or `undefined` while it is built, when the tile shows its empty
 * background.
 *
 * Used for the images a user sent, above their bubble, and for the images a
 * tool returned, under its step.
 */
export function ImageTile({
  name,
  thumbnail,
  onOpen,
}: {
  readonly name: string;
  readonly thumbnail: Blob | undefined;
  readonly onOpen: () => void;
}): JSX.Element {
  const image = useBlobImageSource(thumbnail);
  return (
    <button
      type="button"
      className="image-tile"
      aria-label={`Preview ${name}`}
      title={name}
      onClick={onOpen}
    >
      {thumbnail === undefined ? null : <img ref={image} alt="" draggable={false} />}
    </button>
  );
}
