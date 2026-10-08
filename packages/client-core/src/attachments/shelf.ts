/**
 * The shelf: the images a draft holds above the composer's text, in the order
 * the user attached them.
 *
 * Every function here is pure and returns a new shelf, so a screen keeps the
 * shelf in its draft state and replaces it on each change. An image's upload
 * starts as soon as it is added; the screen runs it (see `createUploadQueue`)
 * and reports the result back with `applyUploadOutcome`. Thumbnails and
 * object URLs are the screen's concern, not the shelf's.
 */
import {
  MAX_ATTACHMENTS_PER_INPUT,
  type Attachment,
  type ModelDescriptor,
} from "@hercule/contract";
import { readValidationIssues } from "../errors";
import { checkImageFile, type ImageFile } from "./files";
import type { UploadOutcome } from "./upload-queue";

/**
 * Why an image that was uploaded but not sent in time cannot be sent: the
 * controller deleted it. The controller refuses such a send with the same
 * words, as `EXPIRED_ATTACHMENT_MESSAGE`.
 */
export const EXPIRED_ATTACHMENT_MESSAGE = "This image expired; attach it again.";

/**
 * The selected model, as far as the shelf needs it:
 *
 * - `imageInput`: the images the model takes, with its own size limit if it
 *   has one, or `null` when it takes none;
 * - `modelName`: its name, for messages.
 */
export interface ShelfModel {
  readonly imageInput: ModelDescriptor["imageInput"];
  readonly modelName: string;
}

/**
 * Formats a size in bytes as megabytes (of 1024 * 1024 bytes) with up to
 * three decimals and no trailing zeros, such as "4 MB" or "3.375 MB". `round`
 * picks the direction of the last decimal: a limit is rounded down and an
 * image's size up, so an image the text calls no larger than the limit is
 * never the one refused. The controller formats its refusal the same way.
 */
const formatMegabytes = (bytes: number, round: (value: number) => number): string =>
  `${String(round((bytes / (1024 * 1024)) * 1000) / 1000)} MB`;

/**
 * Returns why `image` is over `model`'s own size limit, or `undefined` when it
 * is not, or when the model sets no limit. The controller refuses such an
 * image with the same words.
 */
const describeOverModelLimit = (
  image: { readonly name: string; readonly size: number },
  model: ShelfModel,
): string | undefined => {
  const maxBytes = model.imageInput?.maxBytes ?? null;
  if (maxBytes === null || image.size <= maxBytes) return undefined;
  return `"${image.name}" is ${formatMegabytes(image.size, Math.ceil)}; this model accepts images up to ${formatMegabytes(maxBytes, Math.floor)}. Send a smaller image or pick another model.`;
};

/**
 * Where an image's upload stands:
 *
 * - `uploading`: the upload is waiting or running;
 * - `uploaded`: the controller stored it, and `attachment` is its record;
 * - `failed`: the upload failed for `reason`; the user can retry it;
 * - `expired`: the controller deleted the unsent upload after 24 hours, so
 *   the user must attach the file again.
 */
export type ShelfItemStatus =
  | { readonly status: "uploading" }
  | { readonly status: "uploaded"; readonly attachment: Attachment }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "expired" };

/** One image on the shelf. `key` is unique for the life of the page. */
export type ShelfItem = {
  readonly key: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly file: ImageFile;
} & ShelfItemStatus;

let lastKey = 0;

/**
 * Adds files to the end of the shelf, each one `uploading`. Returns the new
 * shelf and a refusal for each file left out:
 *
 * - every file, when the model does not accept images;
 * - a file of the wrong type, an empty one, or one that is too large for
 *   the controller or for the model;
 * - the files past `MAX_ATTACHMENTS_PER_INPUT`, in one refusal.
 */
export const addFilesToShelf = (
  shelf: readonly ShelfItem[],
  files: ReadonlyArray<ImageFile>,
  model: ShelfModel,
): { readonly shelf: readonly ShelfItem[]; readonly refusals: readonly string[] } => {
  if (files.length === 0) return { shelf, refusals: [] };
  if (model.imageInput === null)
    return {
      shelf,
      refusals: [`${model.modelName} does not accept images. Pick a model that accepts them.`],
    };
  const refusals: string[] = [];
  const added: ShelfItem[] = [];
  let tooMany = 0;
  for (const file of files) {
    const refusal = checkImageFile(file) ?? describeOverModelLimit(file, model);
    if (refusal !== undefined) refusals.push(refusal);
    else if (shelf.length + added.length >= MAX_ATTACHMENTS_PER_INPUT) tooMany += 1;
    else {
      lastKey += 1;
      added.push({
        key: `image-${String(lastKey)}`,
        name: file.name,
        sizeBytes: file.size,
        file,
        status: "uploading",
      });
    }
  }
  if (tooMany > 0)
    refusals.push(
      `A message can carry up to ${String(MAX_ATTACHMENTS_PER_INPUT)} images, so ${
        tooMany === 1 ? "1 image was" : `${String(tooMany)} images were`
      } not added.`,
    );
  return { shelf: [...shelf, ...added], refusals };
};

/** Returns the shelf without the item with `key`. */
export const removeShelfItem = (shelf: readonly ShelfItem[], key: string): readonly ShelfItem[] =>
  shelf.filter((item) => item.key !== key);

/**
 * Returns the shelf with the item with `key` set to `status`. The other
 * fields of the old status are dropped. A key that is no longer on the shelf,
 * such as an upload that finished after its image was removed, changes nothing.
 */
const setShelfItemStatus = (
  shelf: readonly ShelfItem[],
  key: string,
  status: ShelfItemStatus,
): readonly ShelfItem[] =>
  shelf.map((item) =>
    item.key === key
      ? { key: item.key, name: item.name, sizeBytes: item.sizeBytes, file: item.file, ...status }
      : item,
  );

/** Returns the shelf with the item with `key` uploaded as `attachment`. */
export const markShelfItemUploaded = (
  shelf: readonly ShelfItem[],
  key: string,
  attachment: Attachment,
): readonly ShelfItem[] => setShelfItemStatus(shelf, key, { status: "uploaded", attachment });

/** Returns the shelf with the item with `key` failed for `reason`. */
export const markShelfItemFailed = (
  shelf: readonly ShelfItem[],
  key: string,
  reason: string,
): readonly ShelfItem[] => setShelfItemStatus(shelf, key, { status: "failed", reason });

/** Returns the shelf with the item with `key` back to `uploading`, for a retry. */
export const markShelfItemUploading = (
  shelf: readonly ShelfItem[],
  key: string,
): readonly ShelfItem[] => setShelfItemStatus(shelf, key, { status: "uploading" });

/**
 * Returns the shelf with the item with `key` set to how its upload ended:
 * uploaded or failed. A cancelled upload changes nothing, because its image
 * was removed from the shelf.
 */
export const applyUploadOutcome = (
  shelf: readonly ShelfItem[],
  key: string,
  outcome: UploadOutcome,
): readonly ShelfItem[] => {
  switch (outcome.status) {
    case "uploaded":
      return markShelfItemUploaded(shelf, key, outcome.attachment);
    case "failed":
      return markShelfItemFailed(shelf, key, outcome.reason);
    case "cancelled":
      return shelf;
  }
};

/** Returns the shelf with every item whose key is in `keys` set to `expired`. */
export const markShelfItemsExpired = (
  shelf: readonly ShelfItem[],
  keys: readonly string[],
): readonly ShelfItem[] =>
  keys.reduce((next, key) => setShelfItemStatus(next, key, { status: "expired" }), shelf);

/** Returns the uploaded items' attachment ids in shelf order: the `attachments` a send carries. */
export const listUploadedAttachmentIds = (shelf: readonly ShelfItem[]): readonly string[] =>
  shelf.flatMap((item) => (item.status === "uploaded" ? [item.attachment.id] : []));

/**
 * Returns the keys of the images a send was refused for because they expired.
 * The controller puts each such issue at `["attachments", i]`, where `i` is
 * the image's position in the `attachments` the send carried, which
 * `listUploadedAttachmentIds` built from the uploaded items in shelf order.
 * Returns `[]` for any other error.
 */
export const findExpiredShelfKeys = (
  error: unknown,
  shelf: readonly ShelfItem[],
): readonly string[] => {
  const uploaded = shelf.filter((item) => item.status === "uploaded");
  return (readValidationIssues(error) ?? []).flatMap((issue) => {
    const [field, index] = issue.path;
    const item =
      field === "attachments" && index !== undefined ? uploaded[Number(index)] : undefined;
    return item === undefined ? [] : [item.key];
  });
};

/**
 * Returns why the draft cannot be sent because of its images, or `null`
 * when the images do not stop it. Checks, in this order:
 *
 * - the model, which must accept images while there are any;
 * - an uploaded image over the model's own size limit;
 * - an expired image, which must be attached again;
 * - a failed upload, which must be retried or removed;
 * - an upload still running.
 */
export const describeSendBlock = (
  shelf: readonly ShelfItem[],
  model: ShelfModel,
): string | null => {
  if (shelf.length === 0) return null;
  if (model.imageInput === null)
    return `${model.modelName} does not accept images. Remove ${
      shelf.length === 1 ? "the image" : `the ${String(shelf.length)} images`
    } or pick a model that accepts them.`;
  for (const item of shelf) {
    const tooLarge =
      item.status === "uploaded"
        ? describeOverModelLimit({ name: item.name, size: item.sizeBytes }, model)
        : undefined;
    if (tooLarge !== undefined) return tooLarge;
  }
  if (shelf.some((item) => item.status === "expired")) return EXPIRED_ATTACHMENT_MESSAGE;
  if (shelf.some((item) => item.status === "failed"))
    return "An image failed to upload. Retry it or remove it.";
  const uploading = shelf.filter((item) => item.status === "uploading").length;
  if (uploading > 0)
    return `Wait for ${uploading === 1 ? "the image" : "the images"} to finish uploading.`;
  return null;
};

/**
 * What a shelf tile shows for one image:
 *
 * - `name`: the state, for styling;
 * - `strip`: the words on the strip along the tile's bottom, short enough for
 *   a 64px tile, or `null` for an uploaded image the model accepts;
 * - `reason`: the longer explanation for the tile's tooltip, or `null`.
 */
export interface ShelfTileState {
  readonly name: "uploading" | "uploaded" | "failed" | "expired" | "unsupported" | "too-large";
  readonly strip: string | null;
  readonly reason: string | null;
}

/**
 * Returns what the tile of `item` shows. A failed or expired image outranks
 * the model, because the user must deal with it first. An uploaded image is
 * then judged against `model`, so a tile changes when the user picks another
 * model:
 *
 * - unsupported, when the model takes no images;
 * - too large, when it is over the model's own size limit.
 */
export const decideShelfTileState = (item: ShelfItem, model: ShelfModel): ShelfTileState => {
  switch (item.status) {
    case "uploading":
      return { name: "uploading", strip: "Uploading…", reason: null };
    case "failed":
      return { name: "failed", strip: "Failed", reason: item.reason };
    case "expired":
      return { name: "expired", strip: "Expired", reason: EXPIRED_ATTACHMENT_MESSAGE };
    case "uploaded": {
      if (model.imageInput === null)
        return {
          name: "unsupported",
          strip: "Unsupported",
          reason: `Not supported by ${model.modelName}`,
        };
      const tooLarge = describeOverModelLimit({ name: item.name, size: item.sizeBytes }, model);
      return tooLarge === undefined
        ? { name: "uploaded", strip: null, reason: null }
        : { name: "too-large", strip: "Too large", reason: tooLarge };
    }
  }
};
