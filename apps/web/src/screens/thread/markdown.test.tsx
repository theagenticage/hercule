/**
 * What the thread's markdown does with prose no agent writes on purpose.
 *
 * The thread screen's own tests cover how an answer reads; these cover the
 * edges that only this component can be held to - a parse that overflows, a
 * class the renderer put there for a reason, a link that goes somewhere else
 * than it says.
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "./markdown";

afterEach(cleanup);

it("falls back to the characters the agent sent when the parser overflows", () => {
  // React reports the caught error on the console; the test is about the
  // fallback, not the noise.
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  const { rerender } = render(<Markdown text={`${">".repeat(6000)} deeply nested`} />);

  expect(screen.getByText(/deeply nested$/).textContent).toContain(">>>");

  // The next answer is not held hostage by the one that overflowed.
  rerender(<Markdown text="**fine** again" />);
  expect(screen.getByText("fine").tagName).toBe("STRONG");
  quiet.mockRestore();
});

it("keeps the class the renderer put on an element and adds its own", () => {
  const { container } = render(<Markdown text={"Note[^1]\n\n[^1]: the body."} />);

  // GFM hides the footnote section's heading from sight; dressing it must not
  // put it back on screen.
  const label = container.querySelector("#footnote-label");
  expect(label?.className).toContain("sr-only");
  expect(label?.className).toContain("font-emph");
});

it("sends a link to a new tab and no referrer with it", () => {
  render(<Markdown text="[the docs](https://example.com/docs)" />);

  const link = screen.getByRole("link", { name: "the docs" });
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
});

it("keeps a link into the page itself in this tab", () => {
  const { container } = render(<Markdown text={"Note[^1]\n\n[^1]: the body."} />);

  // The footnote's number, which scrolls down to its note rather than leaving.
  const footnote = container.querySelector('a[href^="#"]');
  expect(footnote).not.toBeNull();
  expect(footnote?.getAttribute("target")).toBeNull();
  expect(footnote?.getAttribute("rel")).toBeNull();
});

// react-markdown decides this, not us; the test is the fence that notices if
// anyone ever hands it a `urlTransform` of our own.
it("empties the href of a link that is not http, mailto or relative", () => {
  const { container } = render(<Markdown text="[run me](<javascript:alert(1)>)" />);

  const link = container.querySelector("a");
  expect(link?.textContent).toBe("run me");
  expect(link?.getAttribute("href")).toBe("");
});

const ALIGNED_TABLE = ["| l | c | r |", "|:---|:---:|---:|", "| 1 | 2 | 3 |"].join("\n");

it("carries a table column's alignment as a class", () => {
  const { container } = render(<Markdown text={ALIGNED_TABLE} />);

  const cells = [...container.querySelectorAll("tbody td")].map((td) => td.className);
  expect(cells[0]).toContain("text-left");
  expect(cells[1]).toContain("text-center");
  expect(cells[2]).toContain("text-right");
});

// The fence for the Content-Security-Policy the controller serves the bundle
// under: `style-src 'self'` with no `'unsafe-inline'` means the browser drops
// every style attribute. Any markdown construct that starts emitting one fails
// here, rather than silently losing its effect in the shipped binary while
// still working behind a dev server that sends no policy.
it("puts no inline style on anything it renders", () => {
  const { container } = render(<Markdown text={ALIGNED_TABLE} />);

  expect(container.querySelector("[style]")).toBeNull();
});

// A fenced block holds lines nobody wrapped - a CLI's output table, a long
// JSON value - and the card it sits in is only as wide as the column. Without
// this the long line is clipped at the card's edge and the rest is
// unreachable, so the fence scrolls on its own rather than wrapping the
// characters or widening the thread.
it("lets a fenced block scroll sideways instead of clipping a long line", () => {
  const { container } = render(<Markdown text={"```\n" + "x".repeat(400) + "\n```"} />);

  expect(container.querySelector("pre")?.className).toContain("overflow-x-auto");
});
