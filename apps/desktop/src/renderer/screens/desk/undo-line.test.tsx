/**
 * Tests the undo line: that the title comes last and gives way first when the
 * words do not fit, that Undo drops its key hint only after that, and that
 * the line stays while the pointer or the focus is on it.
 */
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useUndoLine } from "../../app/use-undo-line";
import { createUndoStack } from "../../app/undo-stack";
import { cutTitleAtWord, UndoLine } from "./undo-line";

/** Makes the line's words `width` characters wide at most: one pixel a character. */
function fitCharacters(width: number): void {
  const text = (element: HTMLElement): number => element.textContent.length;
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("undo-text") ? text(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("undo-text") ? width : 0;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cutTitleAtWord", () => {
  it("cuts at the last word that ends at 8 letters or later", () => {
    expect(cutTitleAtWord("Fix the delivery slot lookups", 20)).toBe("Fix the delivery");
  });

  it("cuts inside a word when the first word is the only one in reach", () => {
    expect(cutTitleAtWord("Supercalifragilistic thing", 12)).toBe("Supercalifra");
  });

  it("leaves no punctuation at the end of the cut", () => {
    expect(cutTitleAtWord("Checkout revamp: phase two", 17)).toBe("Checkout revamp");
  });
});

describe("UndoLine", () => {
  const line = (title: string, onUndo: (() => void) | null = () => undefined): JSX.Element => (
    <UndoLine
      text="Handed to Review PR"
      title={title}
      onUndo={onUndo}
      action={null}
      undoKey="⌘Z"
      isShown
    />
  );

  it("puts the title last, in quotes", () => {
    render(line("Cache delivery slot lookups"));

    expect(screen.getByRole("status").querySelector(".undo-text")?.textContent).toBe(
      "Handed to Review PR: “Cache delivery slot lookups”",
    );
  });

  it("shortens the title first, at a word", () => {
    fitCharacters(44);
    render(line("Cache delivery slot lookups for five minutes"));

    const words = screen.getByRole("status").querySelector(".undo-text")?.textContent ?? "";
    expect(words.startsWith("Handed to Review PR: “Cache delivery")).toBe(true);
    expect(words.endsWith("…”")).toBe(true);
    expect(words.length).toBeLessThanOrEqual(44);
  });

  it("leaves the title out when 12 letters of it do not fit, and keeps Undo's key", () => {
    fitCharacters(25);
    render(line("Cache delivery slot lookups"));

    expect(screen.getByRole("status").querySelector(".undo-text")?.textContent).toBe(
      "Handed to Review PR",
    );
    expect(screen.getByRole("status").hasAttribute("data-tight")).toBe(false);
  });

  it("drops Undo's key hint only when even the bare words do not fit", () => {
    fitCharacters(10);
    render(line("Cache delivery slot lookups"));

    expect(screen.getByRole("status").hasAttribute("data-tight")).toBe(true);
  });
});

describe("UndoLine held by the pointer or the focus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function Page({ stack }: { readonly stack: ReturnType<typeof createUndoStack<string>> }) {
    const { line, say, hold } = useUndoLine(stack, () => "page");
    return (
      <>
        <button type="button" onClick={() => say("Moved A")}>
          say
        </button>
        <UndoLine
          text={line.text}
          onUndo={null}
          action={null}
          undoKey="⌘Z"
          isShown={line.isShown}
          onHoldChange={hold}
        />
      </>
    );
  }
  const shownLine = (): Element => screen.getByRole("status", { hidden: true });

  it("stays while the pointer is on it, and goes 3 seconds after the pointer leaves", () => {
    render(<Page stack={createUndoStack<string>()} />);
    fireEvent.click(screen.getByText("say"));
    expect(shownLine().className).toContain("is-on");

    fireEvent.pointerEnter(shownLine());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(shownLine().className).toContain("is-on");

    fireEvent.pointerLeave(shownLine());
    act(() => {
      vi.advanceTimersByTime(2_900);
    });
    expect(shownLine().className).toContain("is-on");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(shownLine().className).not.toContain("is-on");
  });

  it("stays while the focus is on it, also when the pointer leaves", () => {
    render(<Page stack={createUndoStack<string>()} />);
    fireEvent.click(screen.getByText("say"));
    const line = shownLine();

    fireEvent.pointerEnter(line);
    fireEvent.focus(line);
    fireEvent.pointerLeave(line);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(line.className).toContain("is-on");
  });
});
