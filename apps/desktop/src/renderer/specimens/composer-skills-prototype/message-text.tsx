/**
 * PROTOTYPE (#766). The text of a user message, sent or queued, with the
 * skills it names drawn as chips.
 *
 * This is a prototype shortcut. It renders the text without Markdown, so it
 * recognises a skill token even inside code, where the real message never
 * does. The real version (#769) adds a skill node to the Markdown tree that
 * `parseMarkdown` in `@hercule/client-core` builds, so code is skipped and
 * the Markdown is kept.
 */
import type { JSX, ReactNode } from "react";
import { findSkillByToken } from "./fixture";
import { SkillChip } from "./skill-chip";

/**
 * A skill token: `$` followed by letters, digits, `-` and `:`, at the start
 * of the text or after whitespace. `x$foo` is not a token, because no
 * whitespace comes before the `$`.
 *
 * A token ends on a letter or a digit. A `-` or `:` at the end, or a run of
 * them, is not part of the token and stays in the text: `$review:` is the
 * token `$review` followed by a colon. A `-` or `:` inside a token stays, as
 * in `$code-review` and `$webshop:release-checklist`. A `.` or `,` also
 * ends a token, so `$review.` is the token `$review` and a full stop.
 */
const SKILL_TOKEN = /(?<=^|\s)\$[A-Za-z0-9:-]*[A-Za-z0-9]/g;

/** A blank line, which starts a new paragraph. */
const PARAGRAPH_BREAK = /\n[^\S\n]*\n\s*/;

/**
 * Returns line number `lineIndex` of a paragraph: its text, with each skill token that
 * names a skill of the thread replaced by a chip. A token that names no
 * skill, such as `$20`, stays plain text.
 */
const renderLine = (line: string, lineIndex: number): ReactNode[] => {
  const pieces: ReactNode[] = [];
  let from = 0;
  for (const match of line.matchAll(SKILL_TOKEN)) {
    const skill = findSkillByToken(match[0]);
    if (skill === undefined) continue;
    if (match.index > from) pieces.push(line.slice(from, match.index));
    pieces.push(
      <SkillChip
        key={`${String(lineIndex)}-${String(match.index)}`}
        skill={skill}
        placement="message"
      />,
    );
    from = match.index + match[0].length;
  }
  if (from < line.length) pieces.push(line.slice(from));
  return pieces;
};

/** Returns a paragraph's lines, a line break between each, as the Markdown render of a message draws them. */
const renderParagraph = (paragraph: string): ReactNode[] =>
  paragraph
    .split("\n")
    .flatMap((line, index) => [
      ...(index === 0 ? [] : [<br key={`break-${String(index)}`} />]),
      ...renderLine(line, index),
    ]);

/**
 * Returns `text` as the Markdown render of a message draws plain text: a
 * `<p>` per paragraph, a line break for each single newline, and a chip for
 * each skill token that names a skill. A text of one paragraph returns its
 * content without the `<p>`, which draws the same inside the bubble and
 * fits the queued input's single line.
 */
export function renderMessageText(text: string): ReactNode {
  const paragraphs = text.trim().split(PARAGRAPH_BREAK);
  if (paragraphs.length === 1) return renderParagraph(paragraphs[0]!);
  return paragraphs.map((paragraph, index): JSX.Element => (
    <p key={index}>{renderParagraph(paragraph)}</p>
  ));
}
