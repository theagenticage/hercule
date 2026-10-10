import type { CSSProperties, JSX } from "react";
import { ImageTile, type TileImage } from "./image-tile";
import "./attachments.css";

/**
 * Renders the images the user sent with a message, above its bubble: two
 * columns at most, one when there is a single image. A click on an image
 * calls `onOpen` with its index, to show it in the lightbox.
 */
export function BubbleImageGrid({
  images,
  onOpen,
}: {
  readonly images: readonly TileImage[];
  readonly onOpen: (index: number) => void;
}): JSX.Element {
  const columns = { "--bubble-columns": Math.min(images.length, 2) } as CSSProperties;
  return (
    <div className="bubble-images" style={columns}>
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
  );
}
