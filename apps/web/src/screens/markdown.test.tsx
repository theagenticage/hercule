/**
 * Tests how the markdown renderer handles unusual input.
 *
 * The thread screen's tests cover how an answer looks. These tests cover what
 * only this component is responsible for: drawing the parsed tree (lists,
 * footnotes, images, table alignment), a parse that overflows, and a link
 * whose target differs from its text. The parser's own tests are in
 * `@hercule/client-core`.
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "./markdown";

afterEach(cleanup);

it("falls back to the characters the agent sent when the parser overflows", () => {
  // React logs the caught error to the console; the test checks the
  // fallback, so the log is silenced.
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  const { rerender } = render(<Markdown text={`${">".repeat(6000)} deeply nested`} />);

  expect(screen.getByText(/deeply nested$/).textContent).toContain(">>>");

  // The next text renders normally after the one that overflowed.
  rerender(<Markdown text="**fine** again" />);
  expect(screen.getByText("fine").tagName).toBe("STRONG");
  quiet.mockRestore();
});

it("opens a link in a new tab without a referrer", () => {
  render(<Markdown text="[the docs](https://example.com/docs)" />);

  const link = screen.getByRole("link", { name: "the docs" });
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
});

it("keeps a link within the page in the same tab", () => {
  const { container } = render(<Markdown text={"Note[^1]\n\n[^1]: the body."} />);

  // The footnote number, which scrolls to its note rather than leaving the page.
  const footnote = container.querySelector('a[href^="#"]');
  expect(footnote).not.toBeNull();
  expect(footnote?.getAttribute("target")).toBeNull();
  expect(footnote?.getAttribute("rel")).toBeNull();
});

it("draws a link with an unsafe address as its text only", () => {
  const { container } = render(<Markdown text="[run me](<javascript:alert(1)>)" />);

  expect(container.querySelector("a")).toBeNull();
  expect(container.textContent).toBe("run me");
});

it("points a footnote's reference and back link at each other", () => {
  const { container } = render(<Markdown text={"Note[^1] again[^1]\n\n[^1]: the body."} />);

  const references = [...container.querySelectorAll("sup a")];
  const note = container.querySelector("section li");
  const backLink = screen.getByRole("link", { name: "Back to reference 1" });

  // The back link goes to the first reference only; the second has no id.
  expect(references).toHaveLength(2);
  expect(references[0]?.id).not.toBe("");
  expect(references[1]?.id).toBe("");
  expect(backLink.getAttribute("href")).toBe(`#${references[0]?.id}`);
  expect(references[0]?.getAttribute("href")).toBe(`#${note?.id}`);

  // The link sits in the note's last paragraph, and the section is named by its hidden heading.
  expect(backLink.closest("p")?.textContent).toBe("the body. \u21a9");
  expect(backLink.textContent).toBe("\u21a9");
  expect(backLink.className).toContain("underline");
  const section = container.querySelector("section");
  const heading = container.querySelector(`[id="${section?.getAttribute("aria-labelledby")}"]`);
  expect(heading?.tagName).toBe("H2");
  expect(heading?.textContent).toBe("Footnotes");
  expect(heading?.className).toBe("sr-only");
  expect(references[0]?.getAttribute("aria-describedby")).toBe(heading?.id);
});

it("keeps the footnote ids of two messages on one screen apart", () => {
  const { container } = render(
    <>
      <Markdown text={"One[^1]\n\n[^1]: first."} />
      <Markdown text={"Two[^1]\n\n[^1]: second."} />
    </>,
  );

  const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
  expect(ids).toHaveLength(6);
  expect(new Set(ids).size).toBe(6);
  const hrefs = [...container.querySelectorAll("a[href^='#']")].map((a) => a.getAttribute("href"));
  expect(hrefs).toHaveLength(4);
  for (const href of hrefs) {
    expect(container.querySelectorAll(`[id="${href?.slice(1)}"]`)).toHaveLength(1);
  }
});

it("draws a tight list's paragraphs bare and a loose list's in paragraphs", () => {
  const tight = render(<Markdown text={"- one\n- two"} />);
  expect(tight.container.querySelector("li p")).toBeNull();
  expect(tight.container.querySelector("li")?.textContent).toBe("one");
  tight.unmount();

  const loose = render(<Markdown text={"- one\n\n- two"} />);
  expect(loose.container.querySelectorAll("li p")).toHaveLength(2);
});

it("numbers an ordered list from its first number", () => {
  const { container } = render(<Markdown text={"3. three\n4. four"} />);

  expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
});

it("draws a task item with a disabled checkbox before its text", () => {
  const { container } = render(<Markdown text={"- [x] done\n- [ ] todo"} />);

  const boxes = [...container.querySelectorAll<HTMLInputElement>("li input[type=checkbox]")];
  expect(boxes.map((box) => box.checked)).toEqual([true, false]);
  expect(boxes.every((box) => box.disabled)).toBe(true);
  expect(container.querySelector("li")?.textContent).toBe(" done");
});

it("draws a task item's checkbox inside its paragraph when the list is loose", () => {
  const { container } = render(<Markdown text={"- [x] one\n\n- [ ] two"} />);

  const boxes = [...container.querySelectorAll("li p > input[type=checkbox]")];
  expect(boxes).toHaveLength(2);
  expect(container.querySelector("li p")?.textContent).toBe(" one");
});

it("sets the title attribute of a link and an image, and omits it when there is none", () => {
  const { container } = render(
    <Markdown
      text={
        '[docs](https://example.com "The docs") [bare](https://example.com/b)\n\n![cat](https://example.com/c.png "A cat")'
      }
    />,
  );

  const [titled, bare] = [...container.querySelectorAll("a")];
  expect(titled?.getAttribute("title")).toBe("The docs");
  expect(bare?.hasAttribute("title")).toBe(false);
  expect(container.querySelector("img")?.getAttribute("title")).toBe("A cat");
});

it("draws an image that sends no referrer", () => {
  const { container } = render(<Markdown text="![a cat](https://example.com/cat.png)" />);

  const image = container.querySelector("img");
  expect(image?.getAttribute("src")).toBe("https://example.com/cat.png");
  expect(image?.getAttribute("alt")).toBe("a cat");
  expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
});

const ALIGNED_TABLE = ["| l | c | r |", "|:---|:---:|---:|", "| 1 | 2 | 3 |"].join("\n");

it("turns a table column's alignment into a class", () => {
  const { container } = render(<Markdown text={ALIGNED_TABLE} />);

  const cells = [...container.querySelectorAll("tbody td")].map((td) => td.className);
  expect(cells[0]).toContain("text-left");
  expect(cells[1]).toContain("text-center");
  expect(cells[2]).toContain("text-right");
});

// Guards against style attributes. Markdown written by an agent must never set
// a style on the page. The controller's Content-Security-Policy allows inline
// styles only because the workflow editor needs them, and the app's own markup
// uses classes only. Any markdown construct that starts to emit a style
// attribute fails this test.
it("puts no inline style on anything it renders", () => {
  const { container } = render(<Markdown text={ALIGNED_TABLE} />);

  expect(container.querySelector("[style]")).toBeNull();
});

// A fenced block holds unwrapped lines, such as a CLI's output table or a
// long JSON value, and its card is only as wide as the column. Without
// scrolling, a long line is clipped at the card's edge and the rest cannot be
// read. So the block scrolls sideways, rather than wrapping the text or
// widening the thread.
it("lets a fenced block scroll sideways instead of clipping a long line", () => {
  const { container } = render(<Markdown text={"```\n" + "x".repeat(400) + "\n```"} />);

  expect(container.querySelector("pre")?.className).toContain("overflow-x-auto");
});

it("draws a details block shut, with its summary and the blocks inside it", () => {
  const { container } = render(
    <Markdown
      text={
        "<details>\n<summary>stripe/stripe-node</summary>\n\nFixes **retry**.\n\n- one\n- two\n\n</details>"
      }
    />,
  );

  const details = container.querySelector("details");
  expect(details?.hasAttribute("open")).toBe(false);
  expect(details?.querySelector("summary")?.textContent).toBe("stripe/stripe-node");
  expect(details?.querySelector("p strong")?.textContent).toBe("retry");
  expect(details?.querySelectorAll("li")).toHaveLength(2);
});

it("keeps an image with a size in the line at that size", () => {
  const { container } = render(
    <Markdown text={'<img src="https://assets.example.com/failed.svg" width="10" height="10">'} />,
  );

  const image = container.querySelector("img");
  expect(image?.getAttribute("width")).toBe("10");
  expect(image?.getAttribute("height")).toBe("10");
  // The base styles make an image a block, which would put a status icon on a line of its own.
  expect(image?.className).toMatch(/\binline\b/);
});

it("keeps the height an image asks for when it asks for no width", () => {
  const { container } = render(
    <Markdown text={'<img src="https://assets.example.com/failed.svg" height="10">'} />,
  );

  // The base styles give every image `height: auto`, which beats the HTML
  // attribute, so a height alone is also set as a style property. A
  // measurement in Electron drew a 100 x 100 image at 10 x 10 this way.
  const image = container.querySelector("img");
  expect(image?.style.height).toBe("10px");
  expect(image?.className).not.toMatch(/\bh-auto\b/);
});

it("lets an image with a width keep its shape by taking its height from the width", () => {
  const { container } = render(
    <Markdown
      text={
        '<img src="https://assets.example.com/a.svg" width="10"> <img src="https://assets.example.com/b.svg" width="10" height="10">'
      }
    />,
  );

  for (const image of container.querySelectorAll("img")) {
    expect(image.className).toMatch(/\bh-auto\b/);
    expect(image.style.height).toBe("");
  }
});

it("draws a table written in HTML with no header row without one", () => {
  const { container } = render(<Markdown text="<table><tr><td>a</td><td>b</td></tr></table>" />);

  expect(container.querySelector("thead")).toBeNull();
  expect([...container.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
    "a",
    "b",
  ]);
});

it("draws a cell across the columns its colspan covers", () => {
  const { container } = render(
    <Markdown text='<table><tr><td>a</td><td>b</td></tr><tr><td colspan="2">footer</td></tr></table>' />,
  );

  const cells = [...container.querySelectorAll("td")];
  expect(cells.map((cell) => cell.getAttribute("colspan"))).toEqual([null, null, "2"]);
});

it("shows every tag as text when embedded HTML is off", () => {
  const { container } = render(<Markdown text="A <b>bold</b> word." embeddedHtml={false} />);

  expect(container.querySelector("b")).toBeNull();
  expect(container.textContent).toBe("A <b>bold</b> word.");
});
