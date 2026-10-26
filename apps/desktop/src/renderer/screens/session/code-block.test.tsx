import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { stubCopyCommand } from "../../app/testing";
import blockStyles from "./code-block.css?raw";
import { CodeBlock } from "./code-block";

/** Renders a code block with the block's stylesheet loaded, and returns its `pre`. */
const renderBlock = (text: string, language: string | undefined): HTMLElement => {
  const style = document.createElement("style");
  style.textContent = blockStyles;
  document.head.append(style);
  const { container } = render(<CodeBlock text={text} language={language} />);
  return container.querySelector("pre")!;
};

afterEach(() => {
  document.head.querySelectorAll("style").forEach((style) => style.remove());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the code block's header", () => {
  it("shows the fence's language as written, outside the code", () => {
    const code = renderBlock("const a = 1;", "TypeScript");

    const language = screen.getByText("TypeScript");
    expect(code.contains(language)).toBe(false);
    expect(code.textContent).toBe("const a = 1;");
  });

  it("shows no language when the fence names none", () => {
    renderBlock("const a = 1;", undefined);

    expect(document.body.textContent).toBe("const a = 1;");
  });

  it("keeps both buttons outside the code, so that only the code scrolls", () => {
    const code = renderBlock("x", undefined);

    for (const name of ["Wrap lines", "Copy code"]) {
      expect(code.contains(screen.getByRole("button", { name }))).toBe(false);
    }
  });
});

describe("the wrap toggle", () => {
  it("is pressed and wraps the lines at first, and turns wrapping off and on again", () => {
    const code = renderBlock("a very long line", "sh");
    const toggle = screen.getByRole("button", { name: "Wrap lines" });

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(code).whiteSpace).toBe("pre-wrap");
    expect(getComputedStyle(code).overflowWrap).toBe("anywhere");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(getComputedStyle(code).whiteSpace).toBe("pre");
    expect(getComputedStyle(code).overflowWrap).not.toBe("anywhere");
    expect(getComputedStyle(code).overflowX).toBe("auto");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(code).whiteSpace).toBe("pre-wrap");
  });

  it("changes one block only", () => {
    render(
      <>
        <CodeBlock text="first" language={undefined} />
        <CodeBlock text="second" language={undefined} />
      </>,
    );
    const [first, second] = screen.getAllByRole("button", { name: "Wrap lines" });

    fireEvent.click(first!);

    expect(first!.getAttribute("aria-pressed")).toBe("false");
    expect(second!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the copy button", () => {
  it("copies the code exactly as the fence holds it", () => {
    const clipboard = stubCopyCommand(true);
    const text = "  indented\n\n\ttabbed <b>&amp;</b>  \n";
    renderBlock(text, "html");

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(clipboard.get("text/plain")).toBe(text);
  });

  it("reads Copied for a moment, says so in a status line, then reads Copy code again", () => {
    vi.useFakeTimers();
    stubCopyCommand(true);
    renderBlock("echo hi", "sh");
    expect(screen.getByRole("status").textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Copied");

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("reads Copy failed when the browser refuses", () => {
    stubCopyCommand(false);
    renderBlock("echo hi", "sh");

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    const failed = screen.getByRole("button", { name: "Copy failed" });
    expect(screen.getByRole("status").textContent).toBe("Copy failed");
    // The glyph is tinted, so that the failure shows to the eye too.
    expect(getComputedStyle(failed).color).toBe("var(--fail-ink)");
  });
});
