/**
 * The reads of stored images: the images a user sent, for the bubble's grid
 * and a queued input's row, and the images a tool returned, under its step.
 * Rows show only thumbnails; the lightbox alone reads an image at full size.
 * Both hooks take only an image's id, which both kinds of image have.
 */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Attachment } from "@hercule/contract";
import { attachmentContentQuery, attachmentThumbnailQuery } from "../../app/queries";
import { toDevicePixels } from "../../app/thumbnails";

/** A stored image, as the controller's `attachment.readContent` reads it by id. */
type StoredImage = Pick<Attachment, "id">;

/**
 * Returns a thumbnail of each of `attachments`, in order, drawn `width` ×
 * `height` CSS pixels: a small WebP blob, or `undefined` while it is being
 * built and when the image cannot be read or decoded.
 */
export function useAttachmentThumbnails(
  attachments: readonly StoredImage[],
  width: number,
  height: number,
): readonly (Blob | undefined)[] {
  const { controller } = useRouteContext({ from: "/_connected" });
  const queryClient = useQueryClient();
  return useQueries({
    queries: attachments.map((attachment) =>
      attachmentThumbnailQuery(
        controller.client,
        queryClient,
        attachment.id,
        toDevicePixels(width),
        toDevicePixels(height),
      ),
    ),
  }).map((query) => query.data);
}

/**
 * Returns the full bytes of `attachment`, for the lightbox, or `undefined`
 * while they load, when the read fails, and while `attachment` is
 * `undefined`, when nothing is read.
 */
export function useAttachmentContent(attachment: StoredImage | undefined): Blob | undefined {
  const { controller } = useRouteContext({ from: "/_connected" });
  return useQuery({
    ...attachmentContentQuery(controller.client, attachment?.id ?? ""),
    enabled: attachment !== undefined,
  }).data;
}
