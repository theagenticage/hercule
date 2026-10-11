/**
 * The snippets of a memory search: a short window of text around each hit in
 * a matching document, so the searcher can tell which document to read in
 * full without reading every one.
 */
import { HIT_END, HIT_START } from "./repository";

/** The most snippets one document contributes to a search result. */
export const MAX_SNIPPETS_PER_DOCUMENT = 3;

/** How many characters of context a snippet keeps on each side of its hit, at most. */
const CONTEXT_LENGTH = 60;

const ELLIPSIS = "…";

/**
 * Builds the snippets of one document from its body with every hit wrapped
 * in `HIT_START` and `HIT_END`, as `memoryRepository.search` returns it.
 * Returns at most `MAX_SNIPPETS_PER_DOCUMENT`, in the order they appear.
 *
 * A snippet is the hit with up to `CONTEXT_LENGTH` characters on each side,
 * cut back to whole words, with `…` where the body goes on. A hit that falls
 * inside the previous snippet adds no snippet of its own. A document that
 * matched only on its name has no hits, and so no snippets.
 */
export const buildSnippets = (markedBody: string): ReadonlyArray<string> => {
  const hits: Array<{ readonly start: number; readonly end: number }> = [];
  let body = "";
  for (const [index, part] of markedBody.split(HIT_START).entries()) {
    if (index === 0) {
      body += part;
      continue;
    }
    const [hit = "", after = ""] = part.split(HIT_END);
    hits.push({ start: body.length, end: body.length + hit.length });
    body += hit + after;
  }

  const snippets: Array<string> = [];
  let covered = 0;
  for (const hit of hits) {
    if (snippets.length === MAX_SNIPPETS_PER_DOCUMENT) break;
    if (hit.start < covered) continue;
    const start = findWordStart(body, Math.max(0, hit.start - CONTEXT_LENGTH), hit.start);
    const end = findWordEnd(body, Math.min(body.length, hit.end + CONTEXT_LENGTH), hit.end);
    snippets.push(
      (start > 0 ? ELLIPSIS : "") +
        body.slice(start, end).trim() +
        (end < body.length ? ELLIPSIS : ""),
    );
    covered = end;
  }
  return snippets;
};

/**
 * Returns where the first whole word at or after `from` starts, never after
 * `maximum`, the start of the hit, so a window that starts mid-word drops the
 * cut part. A window with no space before the hit, such as a long URL or
 * text without spaces, is left as it is.
 */
const findWordStart = (body: string, from: number, maximum: number): number => {
  if (from === 0 || /\s/.test(body[from - 1]!)) return from;
  const space = body.slice(from, maximum).search(/\s/);
  return space === -1 ? from : from + space + 1;
};

/**
 * Returns where the last whole word before `to` ends, never before
 * `minimum`, the end of the hit, so a window that ends mid-word drops the
 * cut part. A window with no space after the hit is left as it is.
 */
const findWordEnd = (body: string, to: number, minimum: number): number => {
  if (to === body.length || /\s/.test(body[to]!)) return to;
  const space = body.slice(minimum, to).search(/\s[^\s]*$/);
  return space === -1 ? to : minimum + space;
};
