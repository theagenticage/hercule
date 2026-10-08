/**
 * Tests the lightbox: its caption, ← and → between the images, and Esc,
 * which closes it. It also checks that the full-size image's object URL is
 * revoked when another image shows and when the lightbox closes.
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageLightbox } from "./image-lightbox";

const NAMES = ["first.png", "second.jpg", "third.webp"];
const SOURCES = NAMES.map((name) => new Blob([name]));

let revoke: MockInstance<(url: string) => void>;

beforeEach(() => {
  // jsdom has no object URLs.
  let made = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:image-${(made += 1)}`);
  revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Renders the lightbox on the second image, as its caller would hold it. */
const renderLightbox = (onClose: () => void) => {
  function Caller() {
    const [index, setIndex] = useState(1);
    return (
      <ImageLightbox
        names={NAMES}
        index={index}
        source={SOURCES[index]}
        onIndexChange={setIndex}
        onClose={onClose}
      />
    );
  }
  return render(<Caller />);
};

describe("the image lightbox", () => {
  it("shows the image with its caption, and steps with the arrow keys within the list", () => {
    renderLightbox(() => {});
    // A browser focuses the dialog itself when it opens, since nothing in it
    // takes focus; jsdom's stub does not, so the keys are pressed on it.
    const press = (key: string): void => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key });
    };
    const dialog = screen.getByRole("dialog", { name: "second.jpg" });
    expect(dialog.querySelector(".lightbox-caption")?.textContent).toBe("second.jpg (2/3)");
    expect(screen.getByRole("img", { name: "second.jpg" }).getAttribute("src")).toBe(
      "blob:image-1",
    );

    press("ArrowRight");
    expect(screen.getByRole("dialog").querySelector(".lightbox-caption")?.textContent).toBe(
      "third.webp (3/3)",
    );
    expect(revoke).toHaveBeenCalledWith("blob:image-1");
    // The last image stays on →.
    press("ArrowRight");
    expect(screen.getByRole("img").getAttribute("alt")).toBe("third.webp");

    for (let step = 0; step < 3; step += 1) press("ArrowLeft");
    expect(screen.getByRole("img").getAttribute("alt")).toBe("first.png");
  });

  it("closes on Esc, and frees the image when it unmounts", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = renderLightbox(onClose);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:image-1");
  });
});
