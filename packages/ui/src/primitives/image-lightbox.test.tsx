import { useState, type JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageLightbox, type LightboxImage } from "./image-lightbox";

const IMAGES: readonly LightboxImage[] = [
  { key: "a", name: "first.png", blob: new Blob(["a"], { type: "image/png" }) },
  { key: "b", name: "second.jpg", blob: new Blob(["b"], { type: "image/jpeg" }) },
  { key: "c", name: "third.gif", blob: new Blob(["c"], { type: "image/gif" }) },
];

/** Renders an "Open" button and the lightbox it opens, the way a bubble or the shelf does. */
function Harness({ start = 0 }: { readonly start?: number | undefined }): JSX.Element {
  const [index, setIndex] = useState<number | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setIndex(start);
        }}
      >
        Open
      </button>
      {index === null ? null : (
        <ImageLightbox
          images={IMAGES}
          index={index}
          onIndexChange={setIndex}
          onClose={() => {
            setIndex(null);
          }}
        />
      )}
    </>
  );
}

const openLightbox = async (start?: number) => {
  const user = userEvent.setup();
  render(<Harness start={start} />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  return user;
};

describe("ImageLightbox", () => {
  it("shows the image with its name and place, and moves with the arrow keys, stopping at the ends", async () => {
    const user = await openLightbox();

    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "first.png (1/3)" }));
    expect(await screen.findByRole("img", { name: "first.png" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous image" }).hasAttribute("disabled")).toBe(
      true,
    );

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("first.png (1/3)");

    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("third.gif (3/3)");
    expect(screen.getByText("(3/3)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next image" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps the arrow keys working after the Next button it was clicked with is disabled", async () => {
    const user = await openLightbox(1);

    await user.click(screen.getByRole("button", { name: "Next image" }));
    await user.keyboard("{ArrowLeft}");

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("second.jpg (2/3)");
  });

  it("closes on Escape and gives the focus back to the button that opened it", async () => {
    const user = await openLightbox();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" }));
    });
  });

  it("closes on a click on the scrim but not on a click on the image", async () => {
    const user = await openLightbox();

    await user.click(await screen.findByRole("img", { name: "first.png" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    await user.click(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    const user = await openLightbox(1);
    const previous = screen.getByRole("button", { name: "Previous image" });
    const close = screen.getByRole("button", { name: "Close" });

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(previous);
  });

  it("revokes the image's object URL when it closes", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const user = await openLightbox();
    const src = (await screen.findByRole("img", { name: "first.png" })).getAttribute("src");

    await user.keyboard("{Escape}");

    expect(revoke).toHaveBeenCalledWith(src);
    revoke.mockRestore();
  });
});
