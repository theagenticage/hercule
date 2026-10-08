/**
 * Runs image uploads a few at a time, in the order they were added, and
 * deletes the uploads the user removes from the shelf.
 *
 * Ten pasted screenshots would otherwise start ten 10 MB uploads at once and
 * hold up every other request to the controller. A failed upload is not tried
 * again on its own: the shelf shows it as failed, and the user retries it.
 */
import type { Attachment } from "@hercule/contract";
import type { ImageFile } from "./files";
import type { ShelfItem } from "./shelf";

/** How many images upload at once, across the whole app. */
export const UPLOAD_CONCURRENCY = 3;

/** How one upload ended. A cancelled upload's result, if it arrives, is dropped. */
export type UploadOutcome =
  | { readonly status: "uploaded"; readonly attachment: Attachment }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "cancelled" };

export interface UploadQueue {
  /**
   * Queues the upload of `file` under `key`, and returns how it ended. The
   * promise never rejects: a failure is an outcome with its reason.
   */
  readonly add: (key: string, file: ImageFile) => Promise<UploadOutcome>;
  /**
   * Lets go of the upload of an image the user removed from the shelf:
   *
   * - an image still uploading is cancelled. A waiting upload never starts,
   *   and a running one's promise resolves `cancelled` at once. The running
   *   request is not aborted, so it keeps its slot until it ends, and the
   *   upload it made is then deleted;
   * - an uploaded image is deleted from the controller;
   * - a failed or expired image has nothing to delete.
   *
   * A delete is not waited for, and a failed one is only logged: the
   * controller deletes any unsent upload after 24 hours anyway.
   */
  readonly discard: (item: ShelfItem) => void;
}

interface Job {
  readonly key: string;
  readonly file: ImageFile;
  readonly settle: (outcome: UploadOutcome) => void;
}

/**
 * Creates a queue that runs at most `concurrency` calls of `upload` at once.
 * An app makes one queue and passes `UPLOAD_CONCURRENCY`, so the limit holds
 * across all its composers.
 */
export const createUploadQueue = (options: {
  readonly upload: (file: ImageFile) => Promise<Attachment>;
  readonly deleteAttachment: (id: string) => Promise<unknown>;
  readonly concurrency: number;
}): UploadQueue => {
  const waiting: Job[] = [];
  const running = new Map<string, Job>();
  let active = 0;

  const deleteUpload = (id: string): void => {
    options.deleteAttachment(id).catch((error: unknown) => {
      console.warn(`Could not delete the removed image ${id}.`, error);
    });
  };

  const cancel = (key: string): void => {
    const index = waiting.findIndex((job) => job.key === key);
    const job = index === -1 ? running.get(key) : waiting.splice(index, 1)[0];
    running.delete(key);
    job?.settle({ status: "cancelled" });
  };

  const startNext = (): void => {
    while (active < options.concurrency) {
      const job = waiting.shift();
      if (job === undefined) return;
      active += 1;
      running.set(job.key, job);
      // The first `then` turns success and failure alike into an outcome, so the chain never rejects.
      void options
        .upload(job.file)
        .then(
          (attachment): UploadOutcome => ({ status: "uploaded", attachment }),
          (error: unknown): UploadOutcome => ({
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          }),
        )
        .then((outcome) => {
          active -= 1;
          if (running.get(job.key) === job) {
            running.delete(job.key);
            job.settle(outcome);
          } else if (outcome.status === "uploaded") {
            // The image was removed while it uploaded, so nothing will send it.
            deleteUpload(outcome.attachment.id);
          }
          startNext();
        });
    }
  };

  return {
    add: (key, file) =>
      new Promise((settle) => {
        waiting.push({ key, file, settle });
        startNext();
      }),
    discard: (item) => {
      if (item.status === "uploading") cancel(item.key);
      else if (item.status === "uploaded") deleteUpload(item.attachment.id);
    },
  };
};
