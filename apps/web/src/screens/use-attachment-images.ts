import { useState, type RefCallback } from "react";
import { useQueries } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Attachment } from "@hercule/contract";
import type { LightboxImage } from "@hercule/ui";
import { attachmentContentQuery } from "../app/queries";

/** The sent images of one message, and the ref that starts reading them. */
export interface AttachmentImages {
  /** The images in the order of `attachments`, ready for a bubble, a queued row or the lightbox. */
  readonly images: readonly LightboxImage[];
  /**
   * A ref callback for the element that shows the images. Their bytes are
   * read once that element first scrolls into view, and never while it is
   * hidden or off screen.
   */
  readonly observe: RefCallback<Element>;
}

/**
 * Returns the sent images `attachments` names, and the ref for the element
 * that shows them. A long transcript can hold many images of up to 10 MB
 * each, so an image's bytes are read only once its element has been on
 * screen. Each image is read once and cached; until its bytes arrive, or when
 * they cannot be read, its `blob` is undefined and it shows as an empty tile.
 */
export function useAttachmentImages(attachments: readonly Attachment[]): AttachmentImages {
  const { client } = useRouteContext({ from: "/_shell" });
  const [seen, setSeen] = useState(false);
  const contents = useQueries({
    queries: attachments.map((attachment) => ({
      ...attachmentContentQuery(client, attachment.id),
      enabled: seen,
    })),
  });
  const observe: RefCallback<Element> = (element) => {
    if (element === null || seen) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setSeen(true);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  };
  return {
    images: attachments.map((attachment, index) => ({
      key: attachment.id,
      name: attachment.name,
      blob: contents[index]?.data,
    })),
    observe,
  };
}
