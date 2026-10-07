import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./markdown";

/** Renders `text` as markdown in a message body, and returns the body. */
const renderMarkdown = (text: string, breaks = false): HTMLElement => {
  const { container } = render(
    <div className="msg-body">
      <Markdown text={text} breaks={breaks} />
    </div>,
  );
  return container.firstElementChild as HTMLElement;
};

describe("Markdown", () => {
  it("renders the blocks straight into the caller's element, with no wrapper", () => {
    const body = renderMarkdown("The pin is now **1.3.2**.\n\n- `.bun-version`\n- `ci.yml`");
    expect([...body.children].map((child) => child.tagName)).toEqual(["P", "UL"]);
    expect(body.querySelector("strong")?.textContent).toBe("1.3.2");
    expect([...body.querySelectorAll("li code")].map((code) => code.textContent)).toEqual([
      ".bun-version",
      "ci.yml",
    ]);
  });

  it("renders a fence as the book's code block, with its text and no colours", () => {
    const body = renderMarkdown("Run this:\n\n```ts\nconst a = 1;\n```");
    const block = body.querySelector("pre");
    expect(block?.className).toBe("codeblock");
    expect(block?.textContent).toBe("const a = 1;\n");
    // No highlighter splits the code into coloured spans.
    expect(block?.querySelectorAll("span")).toHaveLength(0);
  });

  it("shows raw HTML as text, never as elements", () => {
    const html = '<script>alert("hi")</script>';
    const inline = "A <b>bold</b> <img src=x onerror=alert(1)> word.";
    const body = renderMarkdown(`${html}\n\n${inline}`);
    expect(body.querySelector("script, b, img")).toBeNull();
    expect(body.textContent).toBe(`${html}\n${inline}`);
  });

  it("opens a link in the default browser, with no referrer", () => {
    renderMarkdown("See [the runbook](https://example.com/runbook).");
    const link = screen.getByRole("link", { name: "the runbook" });
    expect(link.getAttribute("href")).toBe("https://example.com/runbook");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("keeps a link within the message in the window", () => {
    renderMarkdown("Jump to [the notes](#notes).");
    const link = screen.getByRole("link", { name: "the notes" });
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("rel")).toBeNull();
  });

  it("shows an image as a link to it, as the window loads no image from elsewhere", () => {
    const body = renderMarkdown(
      "The chart: ![retries per hour](https://example.com/chart.png) and ![](https://example.com/raw.png)",
    );
    expect(body.querySelector("img")).toBeNull();
    const named = screen.getByRole("link", { name: "retries per hour" });
    expect(named.getAttribute("href")).toBe("https://example.com/chart.png");
    expect(named.getAttribute("target")).toBe("_blank");
    expect(named.getAttribute("rel")).toBe("noreferrer");
    expect(screen.getByRole("link", { name: "https://example.com/raw.png" })).toBeTruthy();
  });

  it("wraps a table so a wide one scrolls on its own", () => {
    renderMarkdown("| file | lines |\n| --- | --- |\n| ci.yml | 12 |");
    expect(screen.getByRole("table").parentElement?.className).toBe("table-scroll");
  });

  it("keeps a single newline as a line break only when asked", () => {
    expect(renderMarkdown("first\nsecond", true).querySelector("br")).not.toBeNull();
    expect(renderMarkdown("first\nsecond").querySelector("br")).toBeNull();
  });

  it("shows the raw text when the markdown cannot be rendered", () => {
    // React logs the error it caught; the fallback is what is under test.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const text = ">".repeat(6000);
    const body = renderMarkdown(text);
    const fallback = body.querySelector(".markdown-failed");
    expect(fallback?.textContent).toBe(text);
  });
});
