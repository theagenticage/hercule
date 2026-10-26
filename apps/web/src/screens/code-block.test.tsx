/**
 * Tests the code block card: the language in its header, the wrap toggle, and
 * the copy button with its result. The clipboard helper has its own tests, so
 * these stub `navigator.clipboard` and check only what the card does with the
 * result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodeBlock } from "./code-block";

const stubClipboard = (writeText: (text: string) => Promise<void>) => {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
};

/** Clicks the button and waits for the copy's promise to settle. */
const clickAndSettle = async (button: HTMLElement) => {
  await act(() => {
    fireEvent.click(button);
    return Promise.resolve();
  });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the header", () => {
  it("shows the language as written", () => {
    render(<CodeBlock text="x" language="TypeScript" />);

    expect(screen.getByText("TypeScript")).toBeDefined();
  });

  it("shows no language when the block names none, and keeps both buttons", () => {
    const { container } = render(<CodeBlock text="x" />);

    // Only the code is text: the buttons hold icons and the status is empty.
    expect(container.textContent).toBe("x");
    expect(screen.getByRole("button", { name: "Wrap lines" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeDefined();
  });

  it("sits beside the code, never inside it", () => {
    const { container } = render(<CodeBlock text="body" language="ts" />);

    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("body");
    expect(pre?.contains(screen.getByRole("button", { name: "Copy code" }))).toBe(false);
  });
});

describe("wrap", () => {
  it("is on by default and turns off and on again for this block", () => {
    const { container } = render(<CodeBlock text={"x".repeat(400)} />);
    const toggle = screen.getByRole("button", { name: "Wrap lines" });
    const pre = container.querySelector("pre");

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    // `wrap-anywhere` lets one huge token with no spaces break as well.
    expect(pre?.className).toContain("wrap-anywhere");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(pre?.className).toContain("overflow-x-auto");
    expect(pre?.className).not.toContain("whitespace-pre-wrap");
    expect(pre?.className).not.toContain("wrap-anywhere");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("is chosen per block", () => {
    render(
      <>
        <CodeBlock text="one" />
        <CodeBlock text="two" />
      </>,
    );
    const [first, second] = screen.getAllByRole("button", { name: "Wrap lines" });

    fireEvent.click(first!);

    expect(first?.getAttribute("aria-pressed")).toBe("false");
    expect(second?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("copy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("copies the text exactly, with its spaces and newlines", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    const text = "  indented\n\n\ttabbed  \n";
    render(<CodeBlock text={text} language="sh" />);

    await clickAndSettle(screen.getByRole("button", { name: "Copy code" }));

    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("shows Copied, announces it, and returns to normal after 1500 ms", async () => {
    stubClipboard(() => Promise.resolve());
    render(<CodeBlock text="x" />);

    await clickAndSettle(screen.getByRole("button", { name: "Copy code" }));

    expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("Copied");

    await act(() => vi.advanceTimersByTimeAsync(1499));
    expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("button", { name: "Copy code" })).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("shows Copy failed when the browser refuses", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    render(<CodeBlock text="x" />);

    await clickAndSettle(screen.getByRole("button", { name: "Copy code" }));

    expect(screen.getByRole("button", { name: "Copy failed" })).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("Copy failed");
  });

  it("restarts the 1500 ms on a second click", async () => {
    stubClipboard(() => Promise.resolve());
    render(<CodeBlock text="x" />);

    await clickAndSettle(screen.getByRole("button", { name: "Copy code" }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await clickAndSettle(screen.getByRole("button", { name: "Copied" }));
    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
  });

  it("shows the newest copy's result when an older copy finishes after it", async () => {
    const writes: Array<{ resolve: () => void; reject: () => void }> = [];
    stubClipboard(
      () =>
        new Promise<void>((resolve, reject) => {
          writes.push({ resolve, reject: () => reject(new Error("denied")) });
        }),
    );
    render(<CodeBlock text="x" />);
    const button = screen.getByRole("button", { name: "Copy code" });

    fireEvent.click(button);
    fireEvent.click(button);
    await act(() => {
      writes[1]!.resolve();
      return Promise.resolve();
    });
    await act(() => {
      writes[0]!.reject();
      return Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
  });

  it("leaves no timer running after it is removed", async () => {
    stubClipboard(() => Promise.resolve());
    const { unmount } = render(<CodeBlock text="x" />);
    await clickAndSettle(screen.getByRole("button", { name: "Copy code" }));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
