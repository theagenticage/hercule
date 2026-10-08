import { lazy, Suspense, useState, type JSX } from "react";
import type { Attachment } from "@hercule/contract";
import { useAttachmentContent, useAttachmentThumbnails } from "./attachment-contents";
import { BUBBLE_IMAGE_HEIGHT, BUBBLE_IMAGE_WIDTH, BubbleImageGrid } from "./bubble-image";

// The lightbox is a chunk of its own, loaded the first time an image is
// previewed (spec 17 §Performance, rule 6).
const ImageLightbox = lazy(() =>
  import("./image-lightbox").then((module) => ({ default: module.ImageLightbox })),
);

/**
 * Renders the images a user sent with a message, above its bubble, and the
 * lightbox while one of them is open. The bubble shows a thumbnail of each
 * image, built when the message first draws; a tile shows its empty
 * background until it is ready, or when the image cannot be read. The
 * lightbox reads the open image at full size.
 */
export function SentImages({
  attachments,
}: {
  readonly attachments: readonly Attachment[];
}): JSX.Element {
  const thumbnails = useAttachmentThumbnails(attachments, BUBBLE_IMAGE_WIDTH, BUBBLE_IMAGE_HEIGHT);
  const [open, setOpen] = useState<number | null>(null);
  const content = useAttachmentContent(open === null ? undefined : attachments[open]);

  return (
    <>
      <BubbleImageGrid
        images={attachments.map((attachment, index) => ({
          key: attachment.id,
          name: attachment.name,
          thumbnail: thumbnails[index],
        }))}
        onOpen={setOpen}
      />
      {open === null ? null : (
        <Suspense fallback={null}>
          <ImageLightbox
            names={attachments.map((attachment) => attachment.name)}
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
