import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  addFilesToShelf,
  markShelfItemFailed,
  markShelfItemsExpired,
  markShelfItemUploaded,
  type ShelfItem,
  type ShelfModel,
} from "@hercule/client-core";
import { AttachmentShelf } from "./attachment-shelf";

const IMAGES: ShelfModel = { acceptsImages: true, modelName: "Claude Sonnet 5" };

/** Returns a shelf of one image of 436 KB per name, each with the status beside it. */
const buildShelf = (
  ...entries: readonly (readonly [string, ShelfItem["status"]])[]
): readonly ShelfItem[] => {
  const files = entries.map(([name]) =>
    Object.assign(new Blob([new Uint8Array(436 * 1024)], { type: "image/png" }), { name }),
  );
  let shelf = addFilesToShelf([], files, IMAGES).shelf;
  shelf.forEach((item, index) => {
    switch (entries[index]![1]) {
      case "uploading":
        return;
      case "uploaded":
        shelf = markShelfItemUploaded(shelf, item.key, {
          id: `att-${item.name}`,
          name: item.name,
          mimeType: "image/png",
          sizeBytes: item.sizeBytes,
        });
        return;
      case "failed":
        shelf = markShelfItemFailed(shelf, item.key, "The disk is full.");
        return;
      case "expired":
        shelf = markShelfItemsExpired(shelf, [item.key]);
        return;
    }
  });
  return shelf;
};

const renderShelf = (shelf: readonly ShelfItem[], model: ShelfModel = IMAGES) => {
  const handlers = { onPreview: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn() };
  const view = render(<AttachmentShelf shelf={shelf} model={model} {...handlers} />);
  return { ...handlers, shelf, view };
};

const readStrip = (name: string): string =>
  screen.getByRole("button", { name: `Preview ${name}` }).parentElement!.textContent;

describe("AttachmentShelf", () => {
  it("renders nothing when no image is attached, so the card keeps its height", () => {
    const { view } = renderShelf([]);
    expect(view.container.innerHTML).toBe("");
  });

  it("marks each image with its state, and leaves an uploaded one bare", () => {
    renderShelf(
      buildShelf(
        ["a.png", "uploading"],
        ["b.png", "uploaded"],
        ["c.png", "failed"],
        ["d.png", "expired"],
      ),
    );

    expect(readStrip("a.png")).toBe("Uploading…");
    expect(readStrip("b.png")).toBe("");
    expect(readStrip("c.png")).toBe("Failed");
    expect(readStrip("d.png")).toBe("Expired");
    expect(screen.getByRole("button", { name: "Preview a.png" }).parentElement!.title).toBe(
      "a.png · 436 KB",
    );
    expect(screen.getByRole("button", { name: "Preview c.png" }).parentElement!.title).toBe(
      "c.png · 436 KB\nThe disk is full.",
    );
    expect(screen.getByRole("button", { name: "Preview d.png" }).parentElement!.title).toBe(
      "d.png · 436 KB\nThis image expired; attach it again.",
    );
  });

  it("marks every uploaded image when the model does not accept images, and names the model in the tooltip", () => {
    renderShelf(buildShelf(["a.png", "uploaded"], ["b.png", "failed"]), {
      acceptsImages: false,
      modelName: "glm-5.3",
    });

    expect(readStrip("a.png")).toBe("Unsupported");
    expect(readStrip("b.png")).toBe("Failed");
    const item = screen.getByRole("button", { name: "Preview a.png" }).parentElement!;
    expect(item.title).toBe("a.png · 436 KB\nNot supported by glm-5.3");
  });

  it("previews by position and removes and retries by key", async () => {
    const user = userEvent.setup();
    const { onPreview, onRemove, onRetry, shelf } = renderShelf(
      buildShelf(["a.png", "uploaded"], ["b.png", "failed"]),
    );
    const list = screen.getByRole("list", { name: "Attached images" });

    await user.click(within(list).getByRole("button", { name: "Preview b.png" }));
    await user.click(within(list).getByRole("button", { name: "Remove a.png" }));
    await user.click(within(list).getByRole("button", { name: "Retry upload for b.png" }));

    expect(onPreview).toHaveBeenCalledWith(1);
    expect(onRemove).toHaveBeenCalledWith(shelf[0]!.key);
    expect(onRetry).toHaveBeenCalledWith(shelf[1]!.key);
  });
});
