/**
 * Tests the images in a tool's result against the stubbed controller: each
 * stored image is read from the controller and drawn as its thumbnail, an
 * image that could not be kept is a line with its reason and no tile, and a
 * click opens a stored image in the lightbox, counted among the stored
 * images only. An image the tool returned twice is two tiles.
 *
 * jsdom cannot decode images, so the thumbnail builder is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ToolResultImage } from "@hercule/contract";
import { THREAD_FIXTURES } from "../../app/testing";
import { renderThreadPart } from "../thread/testing";
import { ToolResultImages } from "./tool-result-images";

const { buildThumbnail } = vi.hoisted(() => ({ buildThumbnail: vi.fn() }));
vi.mock("../../app/thumbnails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/thumbnails")>()),
  buildThumbnail,
}));

/** The thumbnail the stubbed builder returns for every image. */
const THUMBNAIL = new Blob(["thumbnail"], { type: "image/webp" });

beforeEach(() => {
  buildThumbnail.mockResolvedValue(THUMBNAIL);
  // jsdom has no object URLs.
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) =>
    blob === THUMBNAIL ? "blob:thumbnail" : "blob:other",
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  buildThumbnail.mockReset();
});

const TOO_LARGE = "The image is larger than 10 MB, so it was not kept.";

const STORED_IDS = ["01a06d02-7700-7000-8000-0000000000c1", "01a06d02-7700-7000-8000-0000000000c2"];

const IMAGES: readonly ToolResultImage[] = [
  { type: "image", attachment: { id: STORED_IDS[0]!, mimeType: "image/png", sizeBytes: 4 } },
  { type: "image", unavailable: TOO_LARGE },
  { type: "image", attachment: { id: STORED_IDS[1]!, mimeType: "image/jpeg", sizeBytes: 4 } },
];

/**
 * Renders `images` as the images in a tool's result, and returns the
 * controller's calls.
 */
const renderToolResultImages = async (images: readonly ToolResultImage[] = IMAGES) => {
  const { calls } = await renderThreadPart(() => <ToolResultImages images={images} />, {
    thread: THREAD_FIXTURES.finished,
    handlers: Object.fromEntries(
      STORED_IDS.map((id) => [`GET /api/v1/attachments/${id}/content`, { body: "" }]),
    ),
  });
  return calls;
};

describe("the images in a tool's result", () => {
  it("reads each stored image and draws it as its thumbnail", async () => {
    const calls = await renderToolResultImages();

    const tiles = screen.getAllByRole("button", { name: /^Preview / });
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
      "Preview Image 1",
      "Preview Image 2",
    ]);
    await waitFor(() => {
      expect(tiles.map((tile) => tile.querySelector("img")?.getAttribute("src"))).toEqual([
        "blob:thumbnail",
        "blob:thumbnail",
      ]);
    });
    expect(calls.map((call) => call.path)).toEqual(
      expect.arrayContaining(STORED_IDS.map((id) => `/api/v1/attachments/${id}/content`)),
    );
    // jsdom's device pixel ratio is 1, so device pixels equal CSS pixels.
    expect(buildThumbnail).toHaveBeenCalledWith(
      expect.any(Blob),
      210,
      158,
      expect.any(AbortSignal),
    );
  });

  it("draws an image that could not be kept as a line with its reason, not as a tile", async () => {
    await renderToolResultImages();

    expect(screen.getByText(TOO_LARGE).closest("button")).toBeNull();
  });

  it("opens a clicked image in the lightbox, counted among the stored images", async () => {
    const user = userEvent.setup();
    await renderToolResultImages();

    await user.click(screen.getByRole("button", { name: "Preview Image 2" }));

    expect((await screen.findByText(/Image 2 \(2\/2\)/)).className).toBe("lightbox-caption");
  });

  it("draws an image the tool returned twice as two tiles, each opening its own place", async () => {
    // The runner puts the same reference in every place a repeated image
    // appeared, so the two entries share one attachment id.
    const repeated = IMAGES[0]!;
    const consoleError = vi.spyOn(console, "error");
    const user = userEvent.setup();
    await renderToolResultImages([repeated, repeated]);

    expect(
      screen
        .getAllByRole("button", { name: /^Preview / })
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual(["Preview Image 1", "Preview Image 2"]);
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("Encountered two children with the same key"),
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "Preview Image 2" }));

    expect((await screen.findByText(/Image 2 \(2\/2\)/)).className).toBe("lightbox-caption");
  });
});
