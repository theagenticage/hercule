import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { OpeningSheet, type SheetPlaces } from "./opening-sheet";

afterEach(cleanup);

const PLACES: SheetPlaces = {
  origin: { rect: { left: 10, top: 300, width: 200, height: 90 }, words: null },
  destination: { left: 600, top: 58, width: 468, height: 700 },
};

/** Draws a sheet with a button inside, which a test can press for focus. */
const draw = (isOpen: boolean, onClosed: () => void, contentKey = "a") => (
  <OpeningSheet
    isOpen={isOpen}
    contentKey={contentKey}
    label="Details"
    readPlaces={() => PLACES}
    onClosed={onClosed}
  >
    <h2 data-sheet-focus tabIndex={-1}>
      Words of {contentKey}
    </h2>
    <button type="button">Inside</button>
  </OpeningSheet>
);

describe("OpeningSheet", () => {
  it("is a dialog named by its label that stays usable while open, and inert once closing", async () => {
    const onClosed = vi.fn();
    const { rerender } = render(draw(true, onClosed));
    const sheet = screen.getByRole("dialog", { name: "Details" });
    expect(sheet.hasAttribute("inert")).toBe(false);
    expect(sheet.getAttribute("aria-modal")).toBe("false");

    rerender(draw(false, onClosed));

    expect(sheet.hasAttribute("inert")).toBe(true);
    await waitFor(() => {
      expect(onClosed).toHaveBeenCalledTimes(1);
    });
  });

  it("never calls onClosed for a sheet that was opened again while it closed", async () => {
    const onClosed = vi.fn();
    const { rerender } = render(draw(true, onClosed));

    rerender(draw(false, onClosed));
    rerender(draw(true, onClosed));
    // Give a late call the time to come.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").hasAttribute("inert")).toBe(false);
  });

  it("does not take the focus when it opens, and keeps it in the sheet across a swap if it was there", () => {
    const onClosed = vi.fn();
    const { rerender } = render(draw(true, onClosed));
    expect(document.activeElement).toBe(document.body);

    screen.getByRole("button", { name: "Inside" }).focus();
    rerender(draw(true, onClosed, "b"));

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Words of b" }));
  });
});
