/**
 * PROTOTYPE (#766). The text of a user message, sent or queued, with the
 * skills it names drawn as chips.
 */
import type { JSX, ReactNode } from "react";
import { findSkillByToken } from "./fixture";
import { SkillChip } from "./skill-chip";

/**
 * A skill token: `$` followed by letters, digits, `-` and `:`, at the start
 * of the text or after whitespace. `x$foo` is not a token, because no
 * whitespace comes before the `$`.
 */
const SKILL_TOKEN = /(?<=^|\s)\$[A-Za-z0-9:-]+/g;

/**
 * Returns `text` with each skill token that names a skill of the thread
 * replaced by a chip. A token that names no skill, such as `$20`, stays
 * plain text. Line breaks stay in the text and show as they do in the
 * composer.
 */
export function renderMessageText(text: string): ReactNode {
  const pieces: JSX.Element[] = [];
  let from = 0;
  for (const match of text.matchAll(SKILL_TOKEN)) {
    const skill = findSkillByToken(match[0]);
    if (skill === undefined) continue;
    if (match.index > from) pieces.push(<span key={from}>{text.slice(from, match.index)}</span>);
    pieces.push(<SkillChip key={match.index} skill={skill} placement="message" />);
    from = match.index + match[0].length;
  }
  if (from < text.length) pieces.push(<span key={from}>{text.slice(from)}</span>);
  return pieces;
}
