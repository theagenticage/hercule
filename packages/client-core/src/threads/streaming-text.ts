/**
 * Splits the text of a message the agent is still writing into its finished
 * paragraphs and the paragraph being written, so that only finished
 * paragraphs are drawn as markdown.
 *
 * While a message is open, its text reaches the client in two parts: the
 * stored rows, which the controller writes every 4 KB, and the tail, which
 * holds the token deltas after the last row. Neither part ends where a
 * paragraph ends. The 4 KB cut falls anywhere, even inside a word, and a
 * token can end inside a heading or halfway through a code block. Markdown
 * drawn from such a cut closes its last paragraph at the cut, so a word cut
 * in two would show on two lines, and a code block being written would show
 * half as code and half as prose.
 */

/** The text of an open message, split at the start of its last paragraph. */
export interface StreamingText {
  /** The finished paragraphs, safe to render as markdown on their own. Empty when there are none. */
  readonly settled: string;
  /** The paragraph being written, as plain text. */
  readonly open: string;
}

/** Matches the line that opens or closes a fenced code block: its marker is group 1. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Checks whether `line` closes the fence opened with `opening`: the same
 * character, at least as many times, and nothing else on the line.
 */
const isClosingFence = (line: string, opening: string): boolean => {
  const marker = line.trim();
  return (
    FENCE.test(marker) &&
    /^(.)\1*$/.test(marker) &&
    marker[0] === opening[0] &&
    marker.length >= opening.length
  );
};

/**
 * Splits `text` after its last blank line outside a fenced code block. The
 * part before is `settled`, and the rest is `open`. A blank line inside a
 * fence does not end a paragraph, so a code block still being written stays
 * whole in `open` rather than rendering half as code and half as prose.
 *
 * `from` is the `settled` part of an earlier split of the same message. While
 * `text` starts with it, the scan starts after it rather than at the start of
 * the message, which is scanned again each time the message grows. A settled
 * part ends after a blank line outside any fence, so a scan can start there
 * as it starts a message. When `text` no longer starts with `from`, as when
 * the message's streamed text was dropped, the scan starts at the beginning.
 */
export const splitStreamingText = (text: string, from = ""): StreamingText => {
  const start = text.startsWith(from) ? from.length : 0;
  const lines = text.slice(start).split("\n");
  let settledEnd = start;
  let offset = start;
  let fence: string | null = null;
  // The last element has no newline after it yet, so it is never a
  // finished blank line or a finished fence.
  for (const line of lines.slice(0, -1)) {
    offset += line.length + 1;
    const marker = FENCE.exec(line)?.[1];
    if (fence === null) {
      if (marker !== undefined) fence = marker;
      else if (line.trim() === "") settledEnd = offset;
    } else if (isClosingFence(line, fence)) {
      fence = null;
    }
  }
  return { settled: text.slice(0, settledEnd), open: text.slice(settledEnd) };
};
