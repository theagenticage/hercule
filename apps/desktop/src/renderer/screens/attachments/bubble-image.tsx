import type { CSSProperties, JSX } from "react";
import { useBlobImageSource } from "./thumbnail";
import "./attachments.css";

/** The size a bubble's image is drawn at, in CSS pixels: 210 wide, at 4:3. */
export const BUBBLE_IMAGE_WIDTH = 210;
export const BUBBLE_IMAGE_HEIGHT = 158;

/**
 * Renders one image the user sent, above their bubble, as a button that
 * calls `onOpen` to show it large. `thumbnail` is the image at the bubble's
 * size, or `undefined` while it is built, when the tile shows its empty
 * background.
 */
function BubbleImage({
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
      className="bubble-image"
      aria-label={`Preview ${name}`}
      title={name}
      onClick={onOpen}
    >
      {thumbnail === undefined ? null : <img ref={image} alt="" draggable={false} />}
    </button>
  );
}

/** One image of a sent message, as the bubble's grid draws it. */
export interface BubbleImageTile {
  /** The attachment's id. */
  readonly key: string;
  readonly name: string;
  /** The image at the bubble's size, or `undefined` while it is built. */
  readonly thumbnail: Blob | undefined;
}

/**
 * Renders the images the user sent with a message, above its bubble: two
 * columns at most, one when there is a single image. A click on an image
 * calls `onOpen` with its index, to show it in the lightbox.
 */
export function BubbleImageGrid({
  images,
  onOpen,
}: {
  readonly images: readonly BubbleImageTile[];
  readonly onOpen: (index: number) => void;
}): JSX.Element {
  const columns = { "--bubble-columns": Math.min(images.length, 2) } as CSSProperties;
  return (
    <div className="bubble-images" style={columns}>
      {images.map((image, index) => (
        <BubbleImage
          key={image.key}
          name={image.name}
          thumbnail={image.thumbnail}
          onOpen={() => {
            onOpen(index);
          }}
        />
      ))}
    </div>
  );
}
