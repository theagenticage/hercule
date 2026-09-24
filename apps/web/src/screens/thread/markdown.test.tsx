/**
 * Tests how the thread's markdown handles unusual input.
 *
 * The thread screen's tests cover how an answer looks. These tests cover edge
 * cases only this component is responsible for: a parse that overflows, a
 * class the renderer set for a reason, and a link whose target differs from
 * its text.
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

it("keeps the class the renderer put on an element and adds its own", () => {
  const { container } = render(<Markdown text={"Note[^1]\n\n[^1]: the body."} />);

  // GFM hides the footnote section's heading visually; adding classes must
  // not make it visible again.
  const label = container.querySelector("#footnote-label");
  expect(label?.className).toContain("sr-only");
  expect(label?.className).toContain("font-emph");
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

// react-markdown does this, not our code. The test catches it if someone
// ever passes in a custom `urlTransform`.
it("empties the href of a link that is not http, mailto or relative", () => {
  const { container } = render(<Markdown text="[run me](<javascript:alert(1)>)" />);

  const link = container.querySelector("a");
  expect(link?.textContent).toBe("run me");
  expect(link?.getAttribute("href")).toBe("");
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
