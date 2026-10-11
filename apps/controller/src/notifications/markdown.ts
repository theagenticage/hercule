/**
 * Formats text an agent or a harness wrote so that a notification body shows
 * it as itself. The body is markdown, and text placed in it unformatted could
 * add a link, an image or emphasis the core never meant to show.
 */

/**
 * Returns a run of backticks one longer than the longest run in `text`, and
 * at least `minimum` long. Used as a code fence, it cannot be closed early by
 * backticks inside the text.
 */
const buildFence = (text: string, minimum: number): string => {
  const longestRun = (text.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0);
  return "`".repeat(Math.max(minimum, longestRun + 1));
};

/** Wraps text in a markdown code block. */
export const formatCodeBlock = (text: string): string => {
  const fence = buildFence(text, 3);
  return `${fence}\n${text}\n${fence}`;
};

/**
 * Formats one line of text as markdown inline code, so it renders as itself.
 * Used for paths and for text an agent wrote, such as a subagent's
 * description: inline code cannot add a link, an image or emphasis, and it
 * still reads well where the body is shown as plain text, as in the CLI.
 *
 * Line breaks become spaces first: a blank line would end the code span, and
 * the text after it would render as markdown, links included.
 *
 * The spaces inside the fence keep text that starts or ends with a backtick
 * apart from the fence; markdown drops them when it renders the text.
 */
export const formatInlineCode = (text: string): string => {
  const line = text.replace(/\s*[\r\n]\s*/g, " ");
  const fence = buildFence(line, 1);
  return `${fence} ${line} ${fence}`;
};

/** The longest text a notification title shows from a session or a request. The body shows it whole. */
const MAX_TITLE_TEXT_LENGTH = 80;

/**
 * Shortens text to its first line and at most 80 characters, ending it with
 * an ellipsis when anything was left out, so a title stays one short line.
 */
export const shortenForTitle = (text: string): string => {
  const [first = ""] = text.split("\n");
  const cut = first.length > MAX_TITLE_TEXT_LENGTH || first.length < text.length;
  return cut ? `${first.slice(0, MAX_TITLE_TEXT_LENGTH - 1)}…` : first;
};
