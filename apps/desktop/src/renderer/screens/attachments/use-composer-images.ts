import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  addFilesToShelf,
  applyUploadOutcome,
  describeSendBlock,
  markShelfItemUploading,
  removeShelfItem,
  type ShelfItem,
} from "@hercule/client-core";
import { attachmentContentQuery } from "../../app/queries";
import type { ComposerAttachments } from "../session/composer-frame";

/** What a composer draws and checks for the images on its shelf. */
export interface ComposerImages {
  /** The shelf and its handlers, for `ComposerCard`'s `attachments`. */
  readonly attachments: ComposerAttachments;
  /**
   * The line for the composer's notice slot: why the last files were
   * refused, or else why the images stop the send. `null` when neither.
   */
  readonly notice: string | null;
  /** Whether the images stop the send: an upload running, failed or expired, or a model that takes none. */
  readonly sendBlocked: boolean;
  /** Removes the refusal line, as a send starts. */
  readonly clearRefusal: () => void;
}

/**
 * Runs the shelf of the composer whose pending submission is at `storeKey`,
 * for a model that takes images when `acceptsImages` is true:
 *
 * - pasted, dropped and picked files go on the shelf and start uploading
 *   in the app's upload queue, and refused files are named in the notice;
 * - an upload's result reaches the shelf even when the composer has
 *   unmounted, because the shelf lives in the pending submissions;
 * - an uploaded file is put in the query cache as the attachment's content,
 *   so the bubble of the message that sends it does not read it back;
 * - remove cancels an upload still on its way, and retry starts it again.
 *
 * A read-only composer takes no files, and its Attach stays off.
 */
export function useComposerImages({
  storeKey,
  shelf,
  acceptsImages,
  modelName,
  readOnly,
}: {
  readonly storeKey: string;
  /** The images on the shelf: the pending submission's `message.attachments`. */
  readonly shelf: readonly ShelfItem[];
  readonly acceptsImages: boolean;
  readonly modelName: string;
  readonly readOnly: boolean;
}): ComposerImages {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client, pendingSubmissions, uploads } = controller;
  const queryClient = useQueryClient();
  const [refusal, setRefusal] = useState<string | null>(null);
  const model = { acceptsImages, modelName };

  const startUpload = (item: ShelfItem): void => {
    void uploads.add(item.key, item.file).then((outcome) => {
      if (outcome.status === "cancelled") return;
      if (outcome.status === "uploaded")
        queryClient.setQueryData(
          attachmentContentQuery(client, outcome.attachment.id).queryKey,
          item.file,
        );
      pendingSubmissions.updateAttachments(storeKey, (current) =>
        applyUploadOutcome(current, item.key, outcome),
      );
    });
  };

  const addFiles = (files: readonly File[]): void => {
    const current = pendingSubmissions.read(storeKey).message.attachments;
    const added = addFilesToShelf(current, files, model);
    setRefusal(added.refusals.length === 0 ? null : added.refusals.join(" "));
    if (added.shelf === current) return;
    pendingSubmissions.updateAttachments(storeKey, () => added.shelf);
    for (const item of added.shelf.slice(current.length)) startUpload(item);
  };

  const sendBlock = describeSendBlock(shelf, model);

  return {
    attachments: {
      shelf,
      model,
      onRemove: (key) => {
        uploads.cancel(key);
        pendingSubmissions.updateAttachments(storeKey, (current) => removeShelfItem(current, key));
      },
      onRetry: (key) => {
        const item = shelf.find((each) => each.key === key);
        if (item === undefined) return;
        pendingSubmissions.updateAttachments(storeKey, (current) =>
          markShelfItemUploading(current, key),
        );
        startUpload(item);
      },
      attachBlockedReason: readOnly || acceptsImages ? null : `${modelName} does not accept images`,
      onFiles: addFiles,
    },
    notice: refusal ?? sendBlock,
    sendBlocked: sendBlock !== null,
    clearRefusal: () => {
      setRefusal(null);
    },
  };
}
