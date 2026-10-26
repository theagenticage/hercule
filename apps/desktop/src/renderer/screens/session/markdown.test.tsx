import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import intakeStyles from "../intake/intake.css?raw";
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

  it("renders a fence as a code block with its language, its text and no colours", () => {
    const body = renderMarkdown("Run this:\n\n```ts\nconst a = 1;\n```");
    const block = body.querySelector("pre");
    expect(screen.getByText("ts")).toBeTruthy();
    expect(block?.textContent).toBe("const a = 1;");
    // No highlighter splits the code into coloured spans.
    expect(block?.querySelectorAll("span")).toHaveLength(0);
  });

  it("keeps a code block's wrap choice when the message around it changes", () => {
    const fence = "```ts\nconst a = 1;\n```";
    const { rerender } = render(
      <div className="msg-body">
        <Markdown text={fence} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }));

    // The message goes on after the fence, as a streaming one does once its
    // text is parsed again.
    rerender(
      <div className="msg-body">
        <Markdown text={`${fence}\n\nAnd then more.`} />
      </div>,
    );

    expect(screen.getByRole("button", { name: "Wrap lines" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("draws no script, form or event handler from embedded HTML", () => {
    const body = renderMarkdown(
      '<script>alert("hi")</script>\n\nA <b>bold</b> <img src=x onerror=alert(1)> <form>go</form> word.',
    );
    expect(body.querySelector("script, form, [onerror]")).toBeNull();
    // The script's text goes with it; a form keeps its text.
    expect(body.textContent).not.toContain("alert");
    expect(body.textContent).toContain("go");
    // `<b>` is the tree's bold text, not a `b` element.
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("b")).toBeNull();
  });

  it("shows every tag as text when embedded HTML is off", () => {
    const html = '<script>alert("hi")</script>';
    const inline = "A <b>bold</b> <img src=x onerror=alert(1)> word.";
    const { container } = render(
      <div className="bubble">
        <Markdown text={`${html}\n\n${inline}`} embeddedHtml={false} />
      </div>,
    );
    expect(container.querySelector("script, b, img")).toBeNull();
    expect(container.textContent).toContain(html);
    expect(container.textContent).toContain(inline);
  });

  it("draws a details block shut, with its summary and the blocks inside it", () => {
    const body = renderMarkdown(
      "<details>\n<summary>stripe/stripe-node</summary>\n\nFixes **retry**.\n\n- one\n- two\n\n</details>",
    );
    const details = body.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.firstElementChild?.tagName).toBe("SUMMARY");
    expect(details?.querySelector("summary")?.textContent).toBe("stripe/stripe-node");
    expect(details?.querySelector("p strong")?.textContent).toBe("retry");
    expect(details?.querySelectorAll("li")).toHaveLength(2);
  });

  it("gives an inline image the size its HTML asked for", () => {
    const { container } = render(
      <div className="b-words">
        <Markdown
          text={'<img src="https://assets.example.com/failed.svg" width="10" height="10">'}
          inlineImages
        />
      </div>,
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("width")).toBe("10");
    expect(image?.getAttribute("height")).toBe("10");
  });

  it("draws a cell across the columns its colspan covers", () => {
    const body = renderMarkdown(
      '<table><tr><td>a</td><td>b</td></tr><tr><td colspan="2">footer</td></tr></table>',
    );
    const cells = [...body.querySelectorAll("td")];
    expect(cells.map((cell) => cell.getAttribute("colspan"))).toEqual([null, null, "2"]);
  });

  describe("the size of an inline image", () => {
    // jsdom cannot lay out a page, so this asks whether intake's stylesheet
    // has a rule that sets `height: auto` and matches the image. `auto`
    // replaces the HTML `height` attribute, because any CSS beats an
    // attribute, so an image that asks for a height alone must match none.
    // An Electron measurement drew a 100 x 100 image at 10 x 10 for a height
    // alone, and at 100 x 100 when `auto` matched it.
    const matchesAutoHeight = (html: string): boolean => {
      const style = document.createElement("style");
      style.textContent = intakeStyles;
      document.head.append(style);
      try {
        const { container } = render(
          <div className="b-words">
            <Markdown text={html} inlineImages />
          </div>,
        );
        const image = container.querySelector("img")!;
        return [...document.styleSheets].some((sheet) =>
          [...sheet.cssRules].some(
            (rule) =>
              rule instanceof CSSStyleRule &&
              rule.style.height === "auto" &&
              image.matches(rule.selectorText),
          ),
        );
      } finally {
        style.remove();
      }
    };

    it("keeps the height an image asks for when it asks for no width", () => {
      expect(matchesAutoHeight('<img src="https://example.com/i.svg" height="10">')).toBe(false);
    });

    it("scales an image that gives no height, or a width, with its pane", () => {
      expect(matchesAutoHeight('<img src="https://example.com/i.svg">')).toBe(true);
      expect(matchesAutoHeight('<img src="https://example.com/i.svg" width="10">')).toBe(true);
      expect(
        matchesAutoHeight('<img src="https://example.com/i.svg" width="10" height="10">'),
      ).toBe(true);
    });
  });

  it("draws a table written in HTML with no header row without one", () => {
    const body = renderMarkdown("<table><tr><td>a</td><td>b</td></tr></table>");
    expect(body.querySelector("thead")).toBeNull();
    expect([...body.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      "a",
      "b",
    ]);
  });

  it("opens a link in the default browser, with no referrer", () => {
    renderMarkdown("See [the runbook](https://example.com/runbook).");
    const link = screen.getByRole("link", { name: "the runbook" });
    expect(link.getAttribute("href")).toBe("https://example.com/runbook");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("sets a link's title as the tooltip, and none when it has no title", () => {
    renderMarkdown(
      '[titled](https://example.com/a "The runbook") and [plain](https://example.com/b)',
    );
    expect(screen.getByRole("link", { name: "titled" }).getAttribute("title")).toBe("The runbook");
    expect(screen.getByRole("link", { name: "plain" }).hasAttribute("title")).toBe(false);
  });

  it("keeps a link within the message in the window", () => {
    renderMarkdown("Jump to [the notes](#notes).");
    const link = screen.getByRole("link", { name: "the notes" });
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("rel")).toBeNull();
  });

  it("draws a relative link as its text when asked, and keeps every other link", () => {
    const { container } = render(
      <div className="msg-body">
        <Markdown
          text={
            "Read [the reference](reference.md), [the script](../scripts/run.sh), " +
            "[the docs](https://example.com/docs) and [the notes](#notes). " +
            "![the chart](chart.png) ![](diagram.png)"
          }
          relativeLinksAsText
        />
      </div>,
    );
    expect(container.textContent).toBe(
      "Read the reference, the script, the docs and the notes. the chart diagram.png",
    );
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/docs",
      "#notes",
    ]);
  });

  it("keeps a relative link a link by default", () => {
    renderMarkdown("Read [the reference](reference.md).");
    expect(screen.getByRole("link", { name: "the reference" }).getAttribute("href")).toBe(
      "reference.md",
    );
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

  it("sets an image's title on the inline image and on the link that stands for it", () => {
    const { container } = render(
      <div className="b-words">
        <Markdown
          text={'![a](https://example.com/a.png "Shown") ![b](http://example.com/b.png "Linked")'}
          inlineImages
        />
      </div>,
    );
    expect(container.querySelector("img")?.getAttribute("title")).toBe("Shown");
    expect(screen.getByRole("link", { name: "b" }).getAttribute("title")).toBe("Linked");
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

  it("draws a loose task item's checkbox at the start of its first paragraph", () => {
    const body = renderMarkdown("- [x] first\n\n  second\n\n- [ ] open");
    const paragraphs = [...body.querySelectorAll("li > p")];
    expect(paragraphs.map((p) => p.querySelectorAll("input").length)).toEqual([1, 0, 1]);
    expect(paragraphs[0]?.firstElementChild?.tagName).toBe("INPUT");
  });

  it("puts a footnote's back link in its last paragraph only", () => {
    const body = renderMarkdown("A claim.[^1]\n\n[^1]: First part.\n\n    Second part.");
    const paragraphs = [...body.querySelectorAll("section li p")];
    expect(paragraphs.map((p) => p.textContent)).toEqual(["First part.", "Second part. ↩"]);
    expect(body.querySelectorAll("section a")).toHaveLength(1);
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
