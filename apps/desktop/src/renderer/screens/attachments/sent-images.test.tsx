/**
 * Tests a sent message's images against the stubbed controller: each image
 * is read from the controller and drawn above the bubble as its thumbnail, a
 * tile whose thumbnail cannot be built stays empty, a message with no text
 * draws no bubble, and a click opens the image in the lightbox.
 *
 * jsdom cannot decode images, so the thumbnail builder is stubbed; the
 * desktop end-to-end test `e2e/desktop/thread.test.ts` decodes a real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Attachment } from "@hercule/contract";
import { THREAD_FIXTURES } from "../../app/testing";
import { UserMessage } from "../session/messages";
import { renderThreadPart } from "../thread/testing";

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

const IMAGES: readonly Attachment[] = [
  {
    id: "01a06d02-7700-7000-8000-0000000000a1",
    name: "before.png",
    mimeType: "image/png",
    sizeBytes: 4,
  },
  {
    id: "01a06d02-7700-7000-8000-0000000000a2",
    name: "after.png",
    mimeType: "image/png",
    sizeBytes: 4,
  },
];

/** Renders a message the user sent with `text` and `IMAGES`, and returns the controller's calls. */
const renderMessage = async (text: string) => {
  const { calls } = await renderThreadPart(
    () => (
      <UserMessage
        text={text}
        attachments={IMAGES}
        at="2026-09-10T09:04:00.000Z"
        timezone="UTC"
        today={Date.parse("2026-09-10T00:00:00.000Z")}
      />
    ),
    {
      thread: THREAD_FIXTURES.finished,
      handlers: Object.fromEntries(
        IMAGES.map((image) => [`GET /api/v1/attachments/${image.id}/content`, { body: "" }]),
      ),
    },
  );
  return calls;
};

describe("a sent message's images", () => {
  it("reads each image and draws it above the bubble", async () => {
    const calls = await renderMessage("Which one?");

    const tiles = screen.getAllByRole("button", { name: /^Preview / });
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
      "Preview before.png",
      "Preview after.png",
    ]);
    expect(tiles[0]!.closest(".msg--me")?.querySelector(".bubble")?.textContent).toBe("Which one?");
    await waitFor(() => {
      expect(calls.map((call) => call.path)).toEqual(
        expect.arrayContaining(IMAGES.map((image) => `/api/v1/attachments/${image.id}/content`)),
      );
    });
  });

  it("draws each image as its thumbnail, built at the tile's size", async () => {
    await renderMessage("");

    await waitFor(() => {
      expect(
        screen
          .getAllByRole("button", { name: /^Preview / })
          .map((tile) => tile.querySelector("img")?.getAttribute("src")),
      ).toEqual(["blob:thumbnail", "blob:thumbnail"]);
    });
    // jsdom's device pixel ratio is 1, so device pixels equal CSS pixels.
    expect(buildThumbnail).toHaveBeenCalledWith(
      expect.any(Blob),
      210,
      158,
      expect.any(AbortSignal),
    );
  });

  it("leaves a tile empty when its thumbnail cannot be built", async () => {
    buildThumbnail.mockRejectedValue(new Error("The image cannot be decoded."));
    await renderMessage("");

    await waitFor(() => {
      expect(buildThumbnail).toHaveBeenCalledTimes(2);
    });
    // Lets the failed builds reach the tiles before they are checked.
    await act(async () => {});
    const tiles = screen.getAllByRole("button", { name: /^Preview / });
    expect(tiles.map((tile) => tile.querySelector("img"))).toEqual([null, null]);
  });

  it("draws no bubble for a message with images and no text", async () => {
    await renderMessage("");

    expect(screen.getAllByRole("button", { name: /^Preview / })).toHaveLength(2);
    expect(document.querySelector(".bubble")).toBeNull();
  });

  it("opens a clicked image in the lightbox, captioned with its place among the images", async () => {
    const user = userEvent.setup();
    await renderMessage("");

    await user.click(screen.getByRole("button", { name: "Preview after.png" }));

    expect((await screen.findByText(/after\.png \(2\/2\)/)).className).toBe("lightbox-caption");
  });
});
