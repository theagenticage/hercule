import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import {
  addFilesToShelf,
  applyUploadOutcome,
  decideShelfTileState,
  describeSendBlock,
  EXPIRED_ATTACHMENT_MESSAGE,
  findExpiredShelfKeys,
  listUploadedAttachmentIds,
  markShelfItemFailed,
  markShelfItemsExpired,
  markShelfItemUploaded,
  markShelfItemUploading,
  removeShelfItem,
  type ShelfItem,
} from "./shelf";

const IMAGES = { imageInput: { maxBytes: null }, modelName: "Claude Sonnet 5" };
const NO_IMAGES = { imageInput: null, modelName: "glm-5.3" };
/** A model with its own image size limit: pi's 3.375 MiB. */
const SMALL_IMAGES = { imageInput: { maxBytes: 3_538_944 }, modelName: "glm-5v" };
const FOUR_MIB = 4 * 1024 * 1024;
const TOO_LARGE =
  '"photo.png" is 4 MB; this model accepts images up to 3.375 MB. Send a smaller image or pick another model.';

const buildFile = (name: string, type = "image/png", size = 2048) =>
  Object.assign(new Blob([new Uint8Array(size)], { type }), { name });

const buildAttachment = (id: string, name: string) => ({
  id,
  name,
  mimeType: "image/png" as const,
  sizeBytes: 2048,
});

/** Adds `count` images and returns the shelf. */
const fillShelf = (count: number): readonly ShelfItem[] =>
  addFilesToShelf(
    [],
    Array.from({ length: count }, (_, index) => buildFile(`shot-${String(index)}.png`)),
    IMAGES,
  ).shelf;

describe("addFilesToShelf", () => {
  it("adds each file in order as an upload in progress, under its own key", () => {
    const { shelf, refusals } = addFilesToShelf(
      [],
      [buildFile("a.png"), buildFile("b.png")],
      IMAGES,
    );
    expect(refusals).toEqual([]);
    expect(shelf.map((item) => [item.name, item.sizeBytes, item.status])).toEqual([
      ["a.png", 2048, "uploading"],
      ["b.png", 2048, "uploading"],
    ]);
    expect(new Set(shelf.map((item) => item.key)).size).toBe(2);
  });

  it("refuses a file of the wrong type or too large, and keeps the rest", () => {
    const { shelf, refusals } = addFilesToShelf(
      [],
      [buildFile("notes.txt", "text/plain"), buildFile("ok.png")],
      IMAGES,
    );
    expect(shelf.map((item) => item.name)).toEqual(["ok.png"]);
    expect(refusals).toEqual([
      '"notes.txt" is not an image Hercule can send. Attach a PNG, JPEG, GIF or WebP image.',
    ]);
  });

  it("stops at ten images and says how many were left out", () => {
    const { shelf, refusals } = addFilesToShelf(
      fillShelf(8),
      [buildFile("x.png"), buildFile("y.png"), buildFile("z.png")],
      IMAGES,
    );
    expect(shelf).toHaveLength(10);
    expect(refusals).toEqual(["A message can carry up to 10 images, so 1 image was not added."]);
  });

  it("refuses every file for a model that does not accept images", () => {
    const { shelf, refusals } = addFilesToShelf([], [buildFile("a.png")], NO_IMAGES);
    expect(shelf).toEqual([]);
    expect(refusals).toEqual(["glm-5.3 does not accept images. Pick a model that accepts them."]);
  });

  it("refuses a file over the model's own size limit, and takes it for a model without one", () => {
    const photo = buildFile("photo.png", "image/png", FOUR_MIB);
    const small = addFilesToShelf([], [photo, buildFile("ok.png")], SMALL_IMAGES);
    expect(small.shelf.map((item) => item.name)).toEqual(["ok.png"]);
    expect(small.refusals).toEqual([TOO_LARGE]);
    expect(addFilesToShelf([], [photo], IMAGES).refusals).toEqual([]);
  });

  it("rounds the limit down and the size up, so a refused image never reads as equal to the limit", () => {
    const limit = { imageInput: { maxBytes: 1024 * 1024 - 1 }, modelName: "glm-5v" };
    const { refusals } = addFilesToShelf(
      [],
      [buildFile("photo.png", "image/png", 1024 * 1024)],
      limit,
    );
    expect(refusals).toEqual([
      '"photo.png" is 1 MB; this model accepts images up to 0.999 MB. Send a smaller image or pick another model.',
    ]);
  });
});

describe("the status of a shelf item", () => {
  it("moves from uploading to uploaded or failed, and back to uploading on retry", () => {
    const [first, second] = fillShelf(2);
    const attachment = buildAttachment("att-1", first!.name);
    let shelf = markShelfItemUploaded([first!, second!], first!.key, attachment);
    shelf = markShelfItemFailed(shelf, second!.key, "The controller is unreachable.");
    expect(shelf[0]).toMatchObject({ status: "uploaded", attachment });
    expect(shelf[1]).toMatchObject({ status: "failed", reason: "The controller is unreachable." });

    shelf = markShelfItemUploading(shelf, second!.key);
    expect(shelf[1]).toEqual({ ...second, status: "uploading" });
  });

  it("applies an upload's outcome, and ignores a cancelled one", () => {
    const [first, second] = fillShelf(2);
    const attachment = buildAttachment("att-1", first!.name);
    let shelf = applyUploadOutcome([first!, second!], first!.key, {
      status: "uploaded",
      attachment,
    });
    shelf = applyUploadOutcome(shelf, second!.key, { status: "failed", reason: "offline" });
    expect(shelf[0]).toMatchObject({ status: "uploaded", attachment });
    expect(shelf[1]).toMatchObject({ status: "failed", reason: "offline" });
    expect(applyUploadOutcome(shelf, first!.key, { status: "cancelled" })).toBe(shelf);
  });

  it("ignores an upload that finished after its image was removed", () => {
    const [item] = fillShelf(1);
    const shelf = removeShelfItem([item!], item!.key);
    expect(markShelfItemUploaded(shelf, item!.key, buildAttachment("att-1", "a.png"))).toEqual([]);
  });
});

describe("expired images", () => {
  it("maps each issue at attachments[i] to the i-th uploaded item, skipping the others", () => {
    const [a, b, c] = fillShelf(3);
    // `b` is still uploading, so the send carried only `a` and `c`.
    let shelf: readonly ShelfItem[] = [a!, b!, c!];
    shelf = markShelfItemUploaded(shelf, a!.key, buildAttachment("att-a", a!.name));
    shelf = markShelfItemUploaded(shelf, c!.key, buildAttachment("att-c", c!.name));
    expect(listUploadedAttachmentIds(shelf)).toEqual(["att-a", "att-c"]);

    const error = new ApiError("validation", "Invalid input.", {
      issues: [
        { path: ["attachments", "1"], message: EXPIRED_ATTACHMENT_MESSAGE },
        { path: ["text"], message: "Something else." },
      ],
    });
    const expired = findExpiredShelfKeys(error, shelf);
    expect(expired).toEqual([c!.key]);
    expect(markShelfItemsExpired(shelf, expired).map((item) => item.status)).toEqual([
      "uploaded",
      "uploading",
      "expired",
    ]);
  });

  it("finds nothing in an error that is not a validation error", () => {
    expect(findExpiredShelfKeys(new Error("offline"), fillShelf(1))).toEqual([]);
  });
});

describe("describeSendBlock", () => {
  it("lets an empty shelf or a fully uploaded one send", () => {
    expect(describeSendBlock([], NO_IMAGES)).toBeNull();
    const [item] = fillShelf(1);
    const shelf = markShelfItemUploaded([item!], item!.key, buildAttachment("att-1", "a.png"));
    expect(describeSendBlock(shelf, IMAGES)).toBeNull();
  });

  it("blocks images for a model that does not accept them, counting them", () => {
    expect(describeSendBlock(fillShelf(1), NO_IMAGES)).toBe(
      "glm-5.3 does not accept images. Remove the image or pick a model that accepts them.",
    );
    expect(describeSendBlock(fillShelf(2), NO_IMAGES)).toBe(
      "glm-5.3 does not accept images. Remove the 2 images or pick a model that accepts them.",
    );
  });

  it("blocks on an expired image, then a failed one, then one still uploading", () => {
    const [a, b, c] = fillShelf(3);
    const failed = markShelfItemFailed([a!, b!, c!], b!.key, "offline");
    expect(describeSendBlock(failed, IMAGES)).toBe(
      "An image failed to upload. Retry it or remove it.",
    );
    expect(describeSendBlock(markShelfItemsExpired(failed, [c!.key]), IMAGES)).toBe(
      EXPIRED_ATTACHMENT_MESSAGE,
    );
    expect(describeSendBlock([a!], IMAGES)).toBe("Wait for the image to finish uploading.");
    expect(describeSendBlock([a!, c!], IMAGES)).toBe("Wait for the images to finish uploading.");
  });
});

/** Returns a shelf with one uploaded 4 MiB image, "photo.png", added for a model without a limit. */
const buildLargeUploadedShelf = (): readonly ShelfItem[] => {
  const [item] = addFilesToShelf([], [buildFile("photo.png", "image/png", FOUR_MIB)], IMAGES).shelf;
  return markShelfItemUploaded([item!], item!.key, buildAttachment("att-1", "photo.png"));
};

describe("an image over the model's size limit", () => {
  it("is re-judged when the model changes: too large for one model, fine for another", () => {
    const [item] = buildLargeUploadedShelf();
    expect(decideShelfTileState(item!, IMAGES)).toEqual({
      name: "uploaded",
      strip: null,
      reason: null,
    });
    expect(decideShelfTileState(item!, SMALL_IMAGES)).toEqual({
      name: "too-large",
      strip: "Too large",
      reason: TOO_LARGE,
    });
  });

  it("blocks the send with the same reason, until the model changes", () => {
    const shelf = buildLargeUploadedShelf();
    expect(describeSendBlock(shelf, SMALL_IMAGES)).toBe(TOO_LARGE);
    expect(describeSendBlock(shelf, IMAGES)).toBeNull();
  });
});

describe("decideShelfTileState", () => {
  it("shows each status on the strip, with the reason in the tooltip", () => {
    const [a, b, c, d] = fillShelf(4);
    let shelf: readonly ShelfItem[] = [a!, b!, c!, d!];
    shelf = markShelfItemUploaded(shelf, b!.key, buildAttachment("att-b", b!.name));
    shelf = markShelfItemFailed(shelf, c!.key, "The disk is full.");
    shelf = markShelfItemsExpired(shelf, [d!.key]);
    expect(shelf.map((item) => decideShelfTileState(item, IMAGES))).toEqual([
      { name: "uploading", strip: "Uploading…", reason: null },
      { name: "uploaded", strip: null, reason: null },
      { name: "failed", strip: "Failed", reason: "The disk is full." },
      { name: "expired", strip: "Expired", reason: EXPIRED_ATTACHMENT_MESSAGE },
    ]);
  });

  it("marks an uploaded image unsupported when the model takes no images, but not a failed one", () => {
    const [a, b] = fillShelf(2);
    let shelf = markShelfItemUploaded([a!, b!], a!.key, buildAttachment("att-a", a!.name));
    shelf = markShelfItemFailed(shelf, b!.key, "offline");
    expect(decideShelfTileState(shelf[0]!, NO_IMAGES)).toEqual({
      name: "unsupported",
      strip: "Unsupported",
      reason: "Not supported by glm-5.3",
    });
    expect(decideShelfTileState(shelf[1]!, NO_IMAGES).name).toBe("failed");
  });
});
