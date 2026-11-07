/**
 * Tests the sheet a card opens into: that it opens focused, closes and says so,
 * can be turned round on its way home, gives the card its words back, and asks
 * where the card lies again when its words change. Not its timing.
 */
import { useState, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpeningSheet, type SheetPlaces } from "./index";

const DESTINATION = { left: 100, top: 80, width: 520, height: 300 };

/** Draws a card's words and a sheet over them, with buttons that open, close and swap it. */
function Harness({
  readPlaces,
  onClosed,
}: {
  readonly readPlaces: () => SheetPlaces;
  readonly onClosed: () => void;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(true);
  const [key, setKey] = useState("first");
  return (
    <>
      <button onClick={() => setIsOpen(true)}>Open</button>
      <button onClick={() => setIsOpen(false)}>Close</button>
      <button onClick={() => setKey("second")}>Swap</button>
      <OpeningSheet
        isOpen={isOpen}
        contentKey={key}
        label="Ticket: Retry a payment"
        readPlaces={readPlaces}
        onClosed={onClosed}
        behind={<div data-testid="veil" />}
      >
        <button>A move</button>
        <p>{`Words of ${key}`}</p>
      </OpeningSheet>
    </>
  );
}

const cardWords: HTMLElement[] = [];

/** Returns a card's words element and a `readPlaces` that finds the card there. */
const buildCard = () => {
  const words = document.createElement("div");
  document.body.append(words);
  cardWords.push(words);
  const readPlaces = vi.fn<() => SheetPlaces>(() => ({
    origin: { rect: { left: 400, top: 200, width: 320, height: 90 }, words },
    destination: DESTINATION,
  }));
  return { words, readPlaces };
};

/** Makes the page ask for motion, so the sheet travels instead of fading in place. */
const allowMotion = (): void => {
  document.documentElement.style.setProperty("--dur-2", "0.2s");
};

afterEach(() => {
  document.documentElement.style.removeProperty("--dur-2");
  for (const words of cardWords.splice(0)) words.remove();
});

describe("OpeningSheet", () => {
  it("opens as a named dialog with focus on the sheet and not on a move", () => {
    const { readPlaces } = buildCard();

    render(<Harness readPlaces={readPlaces} onClosed={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Ticket: Retry a payment" });
    expect(document.activeElement).toBe(dialog);
    expect(screen.getByRole("button", { name: "A move" })).toBeTruthy();
  });

  it("stands at its destination when open, and hides the card's words under it", async () => {
    allowMotion();
    const { words, readPlaces } = buildCard();

    render(<Harness readPlaces={readPlaces} onClosed={vi.fn()} />);

    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(Number.parseFloat(dialog.style.left)).toBe(100);
    });
    expect(Number.parseFloat(dialog.style.top)).toBe(80);
    expect(Number.parseFloat(dialog.style.width)).toBe(520);
    expect(Number.parseFloat(dialog.style.height)).toBe(300);
    expect(words.style.opacity).toBe("0");
  });

  it("reports that it has closed once it is home, and gives the card its words back", async () => {
    allowMotion();
    const user = userEvent.setup();
    const { words, readPlaces } = buildCard();
    const onClosed = vi.fn();
    render(<Harness readPlaces={readPlaces} onClosed={onClosed} />);
    await waitFor(() => {
      expect(words.style.opacity).toBe("0");
    });

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(onClosed).toHaveBeenCalledOnce();
    });
    expect(words.style.opacity).toBe("");
  });

  it("turns round when opened again on its way home, and then does not report closing", async () => {
    allowMotion();
    vi.useFakeTimers();
    try {
      const { words, readPlaces } = buildCard();
      const onClosed = vi.fn();
      render(<Harness readPlaces={readPlaces} onClosed={onClosed} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(words.style.opacity).toBe("0");

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      fireEvent.click(screen.getByRole("button", { name: "Open" }));

      // Long enough for a close that was not turned round to have finished.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(onClosed).not.toHaveBeenCalled();
      expect(Number.parseFloat(screen.getByRole("dialog").style.width)).toBe(520);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fades in place under Reduce motion, and still reports that it has closed", async () => {
    const user = userEvent.setup();
    const { readPlaces } = buildCard();
    const onClosed = vi.fn();
    render(<Harness readPlaces={readPlaces} onClosed={onClosed} />);
    expect(Number.parseFloat(screen.getByRole("dialog").style.left)).toBe(100);

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(onClosed).toHaveBeenCalledOnce();
    });
  });

  it("only fades when the card is not on the page, and says it has closed", async () => {
    allowMotion();
    const user = userEvent.setup();
    const onClosed = vi.fn();
    const readPlaces = vi.fn<() => SheetPlaces>(() => ({
      origin: { rect: null, words: null },
      destination: DESTINATION,
    }));
    render(<Harness readPlaces={readPlaces} onClosed={onClosed} />);
    expect(Number.parseFloat(screen.getByRole("dialog").style.left)).toBe(100);

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(onClosed).toHaveBeenCalledOnce();
    });
  });

  it("takes the moves out of the pointer for a moment after it opens", async () => {
    vi.useFakeTimers();
    try {
      const { readPlaces } = buildCard();
      render(<Harness readPlaces={readPlaces} onClosed={vi.fn()} />);
      const dialog = screen.getByRole("dialog");
      expect(dialog.hasAttribute("data-arming")).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(421);
      });

      expect(dialog.hasAttribute("data-arming")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks where the card lies again when its words change, and shows the new words", async () => {
    const user = userEvent.setup();
    const { readPlaces } = buildCard();
    render(<Harness readPlaces={readPlaces} onClosed={vi.fn()} />);
    const askedBefore = readPlaces.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Swap" }));

    expect(screen.getByText("Words of second")).toBeTruthy();
    expect(readPlaces.mock.calls.length).toBeGreaterThan(askedBefore);
  });
});
