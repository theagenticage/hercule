/**
 * Checks that `parseMarkdown` takes time linear in the size of its input for
 * the inputs that once made it slower than linear, and for the kinds of input
 * that tend to. A comment is untrusted and up to hundreds of kilobytes, and
 * the parse runs on the thread that draws the app, so one input that takes
 * seconds freezes it.
 *
 * Each generator makes an input of about the size asked for. The test parses
 * it at a small size and at one 8 times larger. Linear time grows about 8
 * times, and quadratic time about 64 times. The test fails when the time grows
 * more than 20 times, which is clear of both. It takes the fastest of a few
 * runs at each size, so a busy machine does not fail it.
 *
 * Left out, because the slow part is in `marked` and not in this code, and a
 * separate ticket tracks them: `"<b>**y".repeat(n)`, `"- ".repeat(n)`, a run of
 * footnote definitions such as `"[^i]: <b>x\nu\n"`, and a markdown table with
 * thousands of columns and rows.
 */
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";

const SMALL_BYTES = 25_000;
const LARGE_BYTES = 200_000;
const RUNS = 3;
const MAX_GROWTH = 20;

/** Makes text of about `bytes` bytes by repeating `fragment`, after `prefix` and before `suffix`. */
const repeatTo = (fragment: string, prefix = "", suffix = "") => {
  return (bytes: number) => prefix + fragment.repeat(Math.ceil(bytes / fragment.length)) + suffix;
};

const GENERATORS: ReadonlyArray<readonly [name: string, generate: (bytes: number) => string]> = [
  // Tags and brackets without white space, in a block of HTML.
  ["open tags `<a`", repeatTo("<a", "<div>\n")],
  ["open tags `<a=`", repeatTo("<a=", "<div>\n")],
  ['open tags `<a "`', repeatTo('<a "', "<div>\n")],
  ["open tags `<a/`", repeatTo("<a/", "<div>\n")],
  ["open tags `<a<b`", repeatTo("<a<b", "<div>\n")],
  ["open tags with an unclosed quote", repeatTo("<a b='", "<div>\n")],
  ["end tags `</x`", repeatTo("</x", "<div>\n")],
  ["declarations `<!-`", repeatTo("<!-", "<div>\n")],
  ["declarations `<!`", repeatTo("<!", "<div>\n")],
  ["open tags closed at the end", repeatTo("<x", "<div>\n", ">")],
  ["comments `<!--`", repeatTo("<!--", "<div>\n")],
  // Text next to tags that are not HTML or are dropped.
  ["generic types `x<T>` in a block", repeatTo("x<T>", "<div>\n")],
  ["generic types `x<T>` in a line", repeatTo("x<T>")],
  ["dropped tags `x<span>`", repeatTo("x<span>", "<div>\n")],
  ["dropped tags `x<span>` in a line", repeatTo("x<span>")],
  // White space.
  ["spaces kept in pre", (bytes) => `<pre><p>x${" ".repeat(bytes)}y</p></pre>`],
  ["spaces in a paragraph", (bytes) => `<p>x${" ".repeat(bytes)}y</p>`],
  ["spaces in a cell", (bytes) => `<table><tr><td>x${" ".repeat(bytes)}y</td></tr></table>`],
  ["spaces in a heading", (bytes) => `<h1>x${" ".repeat(bytes)}y</h1>`],
  ["spaces between words", repeatTo("x  \n  ", "<div>\n")],
  [
    "spaces kept in code in pre",
    (bytes) => `<pre><code>x${" ".repeat(bytes)}<b>y</b></code></pre>`,
  ],
  // Parts that close each other, and parts without a parent.
  ["cells `<td>x` in a block", repeatTo("<td>x", "<div>\n")],
  ["cells `<td>x` in a row", repeatTo("<td>x", "<table><tr>")],
  ["rows `<tr><td>x`", repeatTo("<tr><td>x", "<table>")],
  [
    "wide rows",
    (bytes) => `<table><tr>${"<td>x".repeat(bytes / 5)}</tr>${"<tr><td>y".repeat(bytes / 20)}`,
  ],
  ["items `<li>x`", repeatTo("<li>x", "<ul>")],
  ["items `<li>x</li>` without a list", repeatTo("<li>x</li>")],
  ["summaries `<summary>x`", repeatTo("<summary>x", "<details>")],
  // Elements that are never closed.
  ["unclosed `<b>`", repeatTo("<b>")],
  ["unclosed `<b>x`", repeatTo("<b>x", "<div>\n")],
  ["unclosed `<div>`", repeatTo("<div>", "", "x")],
  ["unclosed `<code>` and markdown", repeatTo("<code>**x** [^1] ", "", "\n\n[^1]: note")],
  ["close tags without an open tag", repeatTo("</b>x", "<div>\n")],
  ["scripts `<script>x`", repeatTo("<script>x", "<div>\n")],
  // Markdown mixed with HTML.
  ["markdown paragraphs inside details", repeatTo("para **x**\n\n", "<details>\n\n")],
  ["html blocks and paragraphs", repeatTo("<b>x</b>\n\nword\n\n")],
  ["headings inside a quote", repeatTo("> # h <i>x</i>\n")],
  [
    "links and images in HTML",
    repeatTo('<a href="https://e.com/a b">[x](/y)</a><img src="/i.png"> '),
  ],
  ["nested links", repeatTo('<a href="/a">[x](/y) ', "", "</a>")],
  ["list items with HTML", repeatTo("1. <b>x</b>\n")],
  ["table rows with HTML", repeatTo("| <b>x</b> | <i>y</i> |\n", "| a | b |\n|---|---|\n")],
  // Footnotes.
  ["footnote references", repeatTo("x[^1] ", "", "\n\n[^1]: note")],
  ["footnote references in HTML code", repeatTo("<code>[^1]</code> ", "", "\n\n[^1]: note")],
  ["footnotes with HTML", repeatTo("[^1]", "", "\n\n[^1]: <b>x</b> note")],
];

/** Returns the shortest time in milliseconds of `RUNS` parses of `text`. */
const timeParse = (text: string): number => {
  let shortest = Infinity;
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now();
    parseMarkdown(text);
    shortest = Math.min(shortest, performance.now() - started);
  }
  return shortest;
};

describe("parseMarkdown scaling", () => {
  it.each(GENERATORS)("takes linear time for %s", (_name, generate) => {
    const small = timeParse(generate(SMALL_BYTES));
    const large = timeParse(generate(LARGE_BYTES));

    // A parse under a few milliseconds is too short to measure growth from.
    const floor = 5;
    expect(large / Math.max(small, floor)).toBeLessThan(MAX_GROWTH);
  });
});
