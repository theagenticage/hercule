/**
 * Reads whether the caret sits at the end of a `$` or `/` token that opens
 * the list of skills or the list of commands.
 */
import type { EditorState } from "@tiptap/pm/state";
import { findSkillReferences, isSkillReferencePrefix } from "@hercule/contract";
import { readDocumentText } from "./skill-chip-extension";
import type { SkillListKind } from "./skill-list";

/** A token at the caret that opens a list. */
export interface SkillTrigger {
  /** `skills` for a `$` token, `commands` for a `/` token. */
  readonly kind: SkillListKind;
  /** What the user typed after the `$` or `/`, less the `skill:` of a command. The lists filter by it. */
  readonly query: string;
  /** The document position of the `$` or `/`. */
  readonly from: number;
  /** The document position of the caret, which ends the token. */
  readonly to: number;
}

/**
 * A `$` or `/` at the start of the paragraph or after whitespace, and then
 * characters up to the caret. A chip counts as a non-space character,
 * written `￼`, which the name of a token cannot hold.
 */
const TRIGGER_PATTERN = /(?<!\S)([$/])([^\s￼]*)$/;

const COMMAND_PREFIX = "skill:";

/**
 * Returns the token at the caret that opens a list, or `null` when the caret
 * is not at the end of one. Only an empty selection opens a list.
 *
 * - `$` followed by what can start a skill name (`isSkillReferencePrefix`)
 *   opens the skills list, so `$20` opens nothing.
 * - `/` followed by no further `/` opens the commands list, so `/tmp/x`
 *   opens nothing. A typed `skill:` is left out of the query.
 * - Nothing opens in Markdown code. The check swaps the token for `$a` and
 *   asks `findSkillReferences` whether that is a Skill Reference, which it
 *   is not inside an inline code span or a fenced block.
 *
 * Reads one paragraph before the caret. The document up to the token is read
 * as well, but only once a token has been found.
 */
export const readSkillTrigger = (state: EditorState): SkillTrigger | null => {
  const { selection, doc } = state;
  if (!selection.empty || !selection.$head.parent.isTextblock) return null;
  const { $head } = selection;
  const before = $head.parent.textBetween(0, $head.parentOffset, undefined, "￼");
  const match = TRIGGER_PATTERN.exec(before);
  if (match === null) return null;
  const token = match[0];
  const typed = match[2] ?? "";
  const kind: SkillListKind = match[1] === "$" ? "skills" : "commands";
  if (kind === "skills" ? !isSkillReferencePrefix(typed) : typed.includes("/")) return null;
  const from = $head.pos - token.length;
  const probe = `${readDocumentText(doc, from)}$a`;
  if (!findSkillReferences(probe).some((reference) => reference.start === probe.length - 2)) {
    return null;
  }
  const query =
    kind === "commands" && typed.startsWith(COMMAND_PREFIX)
      ? typed.slice(COMMAND_PREFIX.length)
      : typed;
  return { kind, query, from, to: $head.pos };
};
