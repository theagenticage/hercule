/**
 * The words of the Discussions screen: the counts a Discussion shows and the
 * inline code in a subject or a system Post (spec 19 section 8).
 *
 * It is a subpath export of its own, so the first screen does not carry it.
 */
import { formatCount } from "./threads/work-summary";

/** One run of a subject or a system Post's text: plain, or the contents of a backtick code span. */
export interface TextSegment {
  readonly text: string;
  readonly isCode: boolean;
}

/**
 * Splits `text` at its backtick code spans and returns the runs in order.
 * The backticks are dropped, and a run is never empty. An unpaired backtick
 * stays in the plain text, so a stray one never hides the rest of the line.
 *
 * The controller writes a Discussion's subject and its system Posts as plain
 * text with code spans, for paths ("Edits overlap in `src/cart/totals.ts`").
 * They are not Markdown, so the screen draws these runs rather than parsing
 * the text as Markdown.
 */
export const splitInlineCode = (text: string): readonly TextSegment[] => {
  const segments: TextSegment[] = [];
  let rest = text;
  while (rest.length > 0) {
    const open = rest.indexOf("`");
    const close = open === -1 ? -1 : rest.indexOf("`", open + 1);
    if (close === -1) {
      segments.push({ text: rest, isCode: false });
      break;
    }
    if (open > 0) segments.push({ text: rest.slice(0, open), isCode: false });
    if (close > open + 1) segments.push({ text: rest.slice(open + 1, close), isCode: true });
    rest = rest.slice(close + 1);
  }
  return segments;
};

/**
 * Returns `text` without the backticks that mark its code spans, for a
 * screen reader's label of a subject. A stray backtick stays, as in
 * `splitInlineCode`.
 */
export const stripCodeMarks = (text: string): string =>
  splitInlineCode(text)
    .map((segment) => segment.text)
    .join("");

/** Returns "3 sessions · 6 posts": the size chip of an open Discussion shows this text. */
export const describeSessionsAndPosts = (counts: {
  readonly participantCount: number;
  readonly postCount: number;
}): string =>
  `${formatCount(counts.participantCount, "session")} · ${formatCount(counts.postCount, "post")}`;

/** Returns "6 posts · 3 sessions": the second line of a Discussion's row in the narrow list shows this text. */
export const describePostsAndSessions = (counts: {
  readonly participantCount: number;
  readonly postCount: number;
}): string =>
  `${formatCount(counts.postCount, "post")} · ${formatCount(counts.participantCount, "session")}`;
