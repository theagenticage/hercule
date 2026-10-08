import type { JSX } from "react";
import type { Attachment } from "@hercule/contract";
import { useAttachmentThumbnails } from "./attachment-contents";
import { useBlobImageSource } from "./thumbnail";
import "./attachments.css";

/** The size of a queued input's image, in CSS pixels: square, a little taller than the row's text. */
export const QUEUED_IMAGE_SIZE = 20;

/**
 * Renders the images of a queued input as small square tiles, in its row
 * before the text. A tile shows its empty background until its thumbnail is
 * ready, or when the image cannot be read. The image's name is in its
 * tooltip.
 */
export function QueuedImages({
  attachments,
}: {
  readonly attachments: readonly Attachment[];
}): JSX.Element {
  const thumbnails = useAttachmentThumbnails(attachments, QUEUED_IMAGE_SIZE, QUEUED_IMAGE_SIZE);
  return (
    <span className="queued-images">
      {attachments.map((attachment, index) => (
        <QueuedImage key={attachment.id} name={attachment.name} thumbnail={thumbnails[index]} />
      ))}
    </span>
  );
}

/** Renders one image of a queued input: its thumbnail, or the tile's empty background while there is none. */
function QueuedImage({
  name,
  thumbnail,
}: {
  readonly name: string;
  readonly thumbnail: Blob | undefined;
}): JSX.Element {
  const image = useBlobImageSource(thumbnail);
  return (
    <span className="queued-image" title={name}>
      {thumbnail === undefined ? null : <img ref={image} alt={name} draggable={false} />}
    </span>
  );
}
