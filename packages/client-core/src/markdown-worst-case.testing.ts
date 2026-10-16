/**
 * The worst-case inputs of `parseMarkdown`, shared by two test files:
 * `markdown-worst-case.test.ts` checks the output of each, and
 * `markdown.speed.test.ts` times each.
 *
 * A comment is untrusted and can be hundreds of kilobytes long, and the parse
 * runs on the thread that draws the app. These inputs are the ones that once
 * made the parse take seconds, and the kinds of input that tend to.
 *
 * Left out, because their slow part is in `marked` and not in this code, and a
 * separate ticket tracks them: `"<b>**y".repeat(n)`, `"- ".repeat(n)`, a run of
 * footnote definitions such as `"[^i]: <b>x\nu\n"`, and a markdown table with
 * thousands of columns and rows.
 */

/** The size of each input, in characters. */
export const WORST_CASE_BYTES = 200_000;

export interface WorstCaseInput {
  readonly name: string;
  readonly text: string;
  /**
   * The text the parse must show, without white space, in document order, or
   * undefined when it is not simple to say. An empty string means the parse
   * must show nothing. It catches text that a parse loses.
   */
  readonly shownText: string | undefined;
}

interface RepeatedOptions {
  /** What comes before the repeated fragment. */
  readonly before?: string;
  /** What comes after it. */
  readonly after?: string;
  /** The text one repeat of the fragment shows. Leave it out when that is not simple. */
  readonly shows?: string;
  /** The text `before` shows. */
  readonly showsBefore?: string;
  /** The text `after` shows. */
  readonly showsAfter?: string;
}

/** Makes an input of `WORST_CASE_BYTES` characters by repeating `fragment` between `before` and `after`. */
const repeated = (
  name: string,
  fragment: string,
  { before = "", after = "", shows, showsBefore = "", showsAfter = "" }: RepeatedOptions = {},
): WorstCaseInput => {
  const count = Math.ceil(WORST_CASE_BYTES / fragment.length);
  return {
    name,
    text: before + fragment.repeat(count) + after,
    shownText: shows === undefined ? undefined : showsBefore + shows.repeat(count) + showsAfter,
  };
};

export const WORST_CASE_INPUTS: ReadonlyArray<WorstCaseInput> = [
  // Tags and brackets without white space, in a block of HTML.
  repeated("open tags `<a`", "<a", { before: "<div>\n" }),
  repeated("open tags `<a=`", "<a=", { before: "<div>\n" }),
  repeated('open tags `<a "`', '<a "', { before: "<div>\n" }),
  repeated("open tags `<a/`", "<a/", { before: "<div>\n" }),
  repeated("open tags `<a<b`", "<a<b", { before: "<div>\n" }),
  repeated("open tags with an unclosed quote", "<a b='", { before: "<div>\n" }),
  repeated("end tags `</x`", "</x", { before: "<div>\n" }),
  repeated("declarations `<!-`", "<!-", { before: "<div>\n" }),
  repeated("declarations `<!`", "<!", { before: "<div>\n" }),
  repeated("open tags closed at the end", "<x", { before: "<div>\n", after: ">" }),
  repeated("comments `<!--`", "<!--", { before: "<div>\n" }),
  // Text next to tags that are not HTML or are dropped.
  repeated("generic types `x<T>` in a block", "x<T>", { before: "<div>\n", shows: "x<T>" }),
  repeated("generic types `x<T>` in a line", "x<T>", { shows: "x<T>" }),
  repeated("dropped tags `x<span>`", "x<span>", { before: "<div>\n", shows: "x" }),
  repeated("dropped tags `x<span>` in a line", "x<span>", { shows: "x" }),
  // White space.
  {
    name: "spaces kept in pre",
    text: `<pre><p>x${" ".repeat(WORST_CASE_BYTES)}y</p></pre>`,
    shownText: "xy",
  },
  {
    name: "spaces in a paragraph",
    text: `<p>x${" ".repeat(WORST_CASE_BYTES)}y</p>`,
    shownText: "xy",
  },
  {
    name: "spaces in a cell",
    text: `<table><tr><td>x${" ".repeat(WORST_CASE_BYTES)}y</td></tr></table>`,
    shownText: "xy",
  },
  {
    name: "spaces in a heading",
    text: `<h1>x${" ".repeat(WORST_CASE_BYTES)}y</h1>`,
    shownText: "xy",
  },
  repeated("spaces between words", "x  \n  ", { before: "<div>\n", shows: "x" }),
  {
    name: "spaces kept in code in pre",
    text: `<pre><code>x${" ".repeat(WORST_CASE_BYTES)}<b>y</b></code></pre>`,
    shownText: "xy",
  },
  // Parts that close each other, and parts without a parent.
  repeated("cells `<td>x` in a block", "<td>x", { before: "<div>\n", shows: "x" }),
  repeated("cells `<td>x` in a row", "<td>x", { before: "<table><tr>", shows: "x" }),
  repeated("rows `<tr><td>x`", "<tr><td>x", { before: "<table>", shows: "x" }),
  {
    name: "wide rows",
    text: `<table><tr>${"<td>x".repeat(WORST_CASE_BYTES / 5)}</tr>${"<tr><td>y".repeat(WORST_CASE_BYTES / 20)}`,
    shownText: "x".repeat(WORST_CASE_BYTES / 5) + "y".repeat(WORST_CASE_BYTES / 20),
  },
  repeated("items `<li>x`", "<li>x", { before: "<ul>", shows: "x" }),
  repeated("items `<li>x</li>` without a list", "<li>x</li>", { shows: "x" }),
  repeated("summaries `<summary>x`", "<summary>x", { before: "<details>", shows: "x" }),
  // Elements that are never closed.
  repeated("unclosed `<b>`", "<b>", { shows: "" }),
  repeated("unclosed `<b>x`", "<b>x", { before: "<div>\n", shows: "x" }),
  repeated("unclosed `<div>`", "<div>", { after: "x", shows: "", showsAfter: "x" }),
  repeated("close tags without an open tag", "</b>x", { before: "<div>\n", shows: "x" }),
  repeated("scripts `<script>x`", "<script>x", { before: "<div>\n" }),
  // Markdown mixed with HTML.
  repeated("markdown paragraphs inside details", "para **x**\n\n", {
    before: "<details>\n\n",
    shows: "parax",
    showsBefore: "Details",
  }),
  repeated("html blocks and paragraphs", "<b>x</b>\n\nword\n\n", { shows: "xword" }),
  repeated("headings inside a quote", "> # h <i>x</i>\n", { shows: "hx" }),
  repeated(
    "links and images in HTML",
    '<a href="https://e.com/a b">[x](/y)</a><img src="/i.png"> ',
    {
      shows: "x",
    },
  ),
  repeated("nested links", '<a href="/a">[x](/y) ', { after: "</a>", shows: "x" }),
  repeated("list items with HTML", "1. <b>x</b>\n", { shows: "x" }),
  repeated("table rows with HTML", "| <b>x</b> | <i>y</i> |\n", {
    before: "| a | b |\n|---|---|\n",
    shows: "xy",
    showsBefore: "ab",
  }),
  // Footnotes, with HTML.
  repeated("footnote references", "x[^1] ", {
    after: "\n\n[^1]: note",
    shows: "x",
    showsAfter: "note",
  }),
  repeated("footnote references in HTML code", "<code>[^1]</code> ", {
    after: "\n\n[^1]: note",
    shows: "[^1]",
  }),
  repeated("footnotes with HTML", "[^1]", {
    after: "\n\n[^1]: <b>x</b> note",
    shows: "",
    showsAfter: "xnote",
  }),
  // The inputs that once made the footnote parser or marked slow.
  {
    name: "an unterminated comment and many blank lines",
    text: `<!--${"\n".repeat(WORST_CASE_BYTES)}x`,
    shownText: "",
  },
  repeated("a long run of footnote-like brackets", "[^", { shows: "[^" }),
  {
    name: "many footnote definitions and references",
    text: "[^a]: x\n".repeat(20_000) + "[^a] ".repeat(20_000),
    shownText: undefined,
  },
  {
    // The lines become one paragraph, and marked's own paragraph pattern hangs in
    // Bun on Linux somewhere between 20,000 and 50,000 lines, even with no
    // footnote. 20,000 lines still take seconds if reading the definition costs
    // more than linear time.
    name: "a footnote definition with many lazy continuation lines",
    text: `[^a]: first\n${"lazy\n".repeat(20_000)}`,
    shownText: undefined,
  },
  repeated("many paragraphs cut by headings", "a\n# h\n", { shows: "ah" }),
];
