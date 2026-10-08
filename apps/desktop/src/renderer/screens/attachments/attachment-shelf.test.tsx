/**
 * Tests the composer's shelf: a tile per image with its preview and remove
 * buttons, the strip that names an upload's state, and retry on a failed
 * upload. jsdom decodes no images, so the tiles show no thumbnail.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ShelfItem, ShelfItemStatus, ShelfModel } from "@hercule/client-core";
import { AttachmentShelf } from "./attachment-shelf";

const ATTACHMENT = { name: "x.png", mimeType: "image/png", sizeBytes: 446_464 } as const;

const buildItem = (key: string, status: ShelfItemStatus): ShelfItem => ({
  key,
  name: `${key}.png`,
  sizeBytes: 446_464,
  file: new File([], `${key}.png`, { type: "image/png" }),
  ...status,
});

const UPLOADED: ShelfItemStatus = { status: "uploaded", attachment: { id: "a-1", ...ATTACHMENT } };

const renderShelf = (
  shelf: readonly ShelfItem[],
  imageInput: ShelfModel["imageInput"] = { maxBytes: null },
) => {
  const onRemove = vi.fn();
  const onRetry = vi.fn();
  const view = render(
    <AttachmentShelf
      shelf={shelf}
      model={{ imageInput, modelName: "glm-5.3" }}
      onRemove={onRemove}
      onRetry={onRetry}
    />,
  );
  return { ...view, onRemove, onRetry };
};

describe("the attachment shelf", () => {
  it("renders nothing without images", () => {
    const { container } = renderShelf([]);
    expect(container.innerHTML).toBe("");
  });

  it("previews and removes an image", async () => {
    const user = userEvent.setup();
    const { onRemove } = renderShelf([buildItem("one", UPLOADED), buildItem("two", UPLOADED)]);

    await user.click(screen.getByRole("button", { name: "Preview two.png" }));
    expect((await screen.findByText("two.png (2/2)")).className).toBe("lightbox-caption");
    await user.click(screen.getByRole("button", { name: "Remove one.png" }));
    expect(onRemove).toHaveBeenCalledWith("one");
    // An uploaded image has no strip, and its tooltip names it and its size.
    const tile = screen.getByRole("button", { name: "Preview one.png" }).closest("li")!;
    expect(tile.title).toBe("one.png · 436 KB");
    expect(tile.querySelector(".shelf-strip")).toBeNull();
  });

  it("names each upload's state in the tile's strip, and the reason in its tooltip", () => {
    renderShelf(
      [
        buildItem("a", { status: "uploading" }),
        buildItem("b", { status: "failed", reason: "The controller did not answer in time." }),
        buildItem("c", { status: "expired" }),
        buildItem("d", UPLOADED),
      ],
      null,
    );
    const strips = [...document.querySelectorAll(".shelf-strip-text")].map(
      (strip) => strip.textContent,
    );
    expect(strips).toEqual(["Uploading…", "Failed", "Expired", "Unsupported"]);
    const readTitle = (name: string): string =>
      screen.getByRole("button", { name: `Preview ${name}` }).closest("li")!.title;
    expect(readTitle("b.png")).toBe("b.png · 436 KB\nThe controller did not answer in time.");
    expect(readTitle("c.png")).toBe("c.png · 436 KB\nThis image expired; attach it again.");
    expect(readTitle("d.png")).toBe("d.png · 436 KB\nNot supported by glm-5.3");
  });

  it("offers retry only on a failed upload", async () => {
    const user = userEvent.setup();
    const { onRetry } = renderShelf([
      buildItem("a", { status: "uploading" }),
      buildItem("b", { status: "failed", reason: "Offline" }),
    ]);

    const retries = screen.getAllByRole("button", { name: /^Retry upload/ });
    expect(retries.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Retry upload for b.png",
    ]);
    await user.click(retries[0]!);
    expect(onRetry).toHaveBeenCalledWith("b");
    const uploading = screen.getByRole("button", { name: "Preview a.png" }).closest("li")!;
    expect(within(uploading).queryByRole("button", { name: /^Retry/ })).toBeNull();
  });
});
