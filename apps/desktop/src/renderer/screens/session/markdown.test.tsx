import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
    expect(block?.textContent).toBe("const a = 1;");
    // No highlighter splits the code into coloured spans.
    expect(block?.querySelectorAll("span")).toHaveLength(0);
  });

  it("shows raw HTML as text, never as elements", () => {
    const html = '<script>alert("hi")</script>';
    const inline = "A <b>bold</b> <img src=x onerror=alert(1)> word.";
    const body = renderMarkdown(`${html}\n\n${inline}`);
    expect(body.querySelector("script, b, img")).toBeNull();
    expect(body.textContent).toContain(html);
    expect(body.textContent).toContain(inline);
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

  it("shows https images inline only when asked, and any other image as a link", () => {
    const { container } = render(
      <div className="b-words">
        <Markdown
          text="![retries per hour](https://example.com/chart.png) ![local](http://example.com/a.png)"
          inlineImages
        />
      </div>,
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://example.com/chart.png");
    expect(image?.getAttribute("alt")).toBe("retries per hour");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "local" }).getAttribute("href")).toBe(
      "http://example.com/a.png",
    );
  });

  it("shows an image as a link to it, so reading a message loads nothing from elsewhere", () => {
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

  it("aligns a table's columns with an attribute, never a style", () => {
    const body = renderMarkdown("| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |");
    const cells = [...body.querySelectorAll("tbody td")];
    expect(cells.map((cell) => cell.getAttribute("data-align"))).toEqual([
      "left",
      "center",
      "right",
      null,
    ]);
    expect(body.querySelector("thead th:nth-child(2)")?.getAttribute("data-align")).toBe("center");
    expect(body.querySelector("[style]")).toBeNull();
  });

  it("draws a tight list's items as bare text and a loose list's as paragraphs", () => {
    const tight = renderMarkdown("- one\n- two");
    expect(tight.querySelectorAll("li")).toHaveLength(2);
    expect(tight.querySelector("li p")).toBeNull();
    const loose = renderMarkdown("- one\n\n- two");
    expect([...loose.querySelectorAll("li > p")].map((p) => p.textContent)).toEqual(["one", "two"]);
  });

  it("starts a numbered list where the text does", () => {
    expect(renderMarkdown("3. three\n4. four").querySelector("ol")?.getAttribute("start")).toBe(
      "3",
    );
    expect(renderMarkdown("1. one\n2. two").querySelector("ol")?.hasAttribute("start")).toBe(false);
  });

  it("draws a task item's disabled checkbox before its text", () => {
    const body = renderMarkdown("- [x] done\n- [ ] open");
    const boxes = [...body.querySelectorAll<HTMLInputElement>("li > input[type=checkbox]")];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(boxes.every((box) => box.disabled)).toBe(true);
    expect([...body.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      " done",
      " open",
    ]);
  });

  it("links a footnote's reference and its back link to each other", () => {
    const body = renderMarkdown("A claim.[^1]\n\n[^1]: The source.");
    const reference = body.querySelector("sup a") as HTMLAnchorElement;
    const note = body.querySelector("section[aria-label='Footnotes'] li") as HTMLElement;
    expect(reference.getAttribute("href")).toBe(`#${note.id}`);
    const back = within(note).getByRole("link", { name: "Back to reference 1" });
    expect(back.getAttribute("href")).toBe(`#${reference.id}`);
    expect(reference.id).not.toBe("");
    // The back link sits in the footnote's last paragraph, after its text.
    expect(back.closest("p")?.textContent).toBe("The source. ↩");
  });

  it("gives two messages on screen different footnote ids", () => {
    const { container } = render(
      <>
        <Markdown text={"One.[^1]\n\n[^1]: First."} />
        <Markdown text={"Two.[^1]\n\n[^1]: Second."} />
      </>,
    );
    const ids = [...container.querySelectorAll("li[id]")].map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
  });

  it("draws no footnotes section when the text has no footnote", () => {
    expect(renderMarkdown("Plain.").querySelector("section")).toBeNull();
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
