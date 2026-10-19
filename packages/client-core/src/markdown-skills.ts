/**
 * Decides which `$name` in a message are skill chips, once, on the message as
 * the person wrote it. The runner finds Skill References by scanning the raw
 * message, so a chip is truthful only where that scan found one. The Markdown
 * parser removes and rewrites characters (`>`, tags, entities), so the raw scan
 * cannot be repeated on the parsed text. Instead:
 *
 * 1. `markSkillReferences` replaces the `$` of each reference to a listed skill
 *    in the raw message with a private-use character. The text keeps its length.
 * 2. The message is parsed as usual. The mark is an ordinary character to the
 *    parser, so it ends up in the text of whatever the parser makes of it.
 * 3. `splitMarkedSkillReferences` turns each mark in a text into a skill node.
 * 4. `restoreSkillMarks` puts a `$` back for every mark that is left, in any
 *    string of the tree: link addresses, alt text, code and the like.
 */

import {
  findSkillReferences,
  isSkillNameCharacter,
  readSkillReferenceName,
} from "@hercule/contract";
import { decodeCharacterReferences } from "./markdown-text";
import type { MarkdownDocument, MarkdownInline } from "./markdown-tree";

/**
 * The character that stands in for the `$` of a Skill Reference while the
 * message is parsed. It is in the Unicode private use area, so no text, and no
 * part of the Markdown grammar, gives it a meaning.
 */
const SKILL_MARK = "\uE000";

const ESCAPE_OR_ENTITY_PATTERN = /^(?:\\[\s\S]|&#?\w+;)/;

/**
 * Checks whether the parser would decode the entity or escape that starts at
 * `index` in `text` to a character that a skill name can hold.
 */
const continuesName = (text: string, index: number): boolean => {
  const written = ESCAPE_OR_ENTITY_PATTERN.exec(text.slice(index))?.[0];
  if (written === undefined) return false;
  const decoded = written.startsWith("\\") ? written.slice(1) : decodeCharacterReferences(written);
  return isSkillNameCharacter(decoded[0] ?? "");
};

/**
 * Returns `text` with the `$` of each Skill Reference to a skill in
 * `skillNames` replaced by `SKILL_MARK`, as found by `findSkillReferences` in the
 * raw text. Returns `text` itself when it holds no such reference. Also returns
 * `text` itself when it already holds `SKILL_MARK`, so that a mark in the result
 * always comes from this function; such a message draws no chips.
 *
 * A reference is not marked when an entity (`&#105;`) or an escape (`\-`) follows
 * its name and stands for a character a name can hold. The parser decodes both,
 * so the character would join the name in the tree: `$rev&#105;ew` is `$review`
 * there, while the scan read `rev`. These are the only two ways the tree text
 * after a name differs from the raw text; tags and emphasis split the text into
 * separate nodes instead. Such a reference stays plain text.
 */
export const markSkillReferences = (text: string, skillNames: ReadonlySet<string>): string => {
  if (skillNames.size === 0 || text.includes(SKILL_MARK)) return text;
  let marked = "";
  let from = 0;
  for (const reference of findSkillReferences(text)) {
    if (!skillNames.has(reference.name)) continue;
    if (continuesName(text, reference.end)) continue;
    marked += text.slice(from, reference.start) + SKILL_MARK;
    from = reference.start + 1;
  }
  return from === 0 ? text : marked + text.slice(from);
};

/**
 * Splits `text` into text and skill nodes, in text order. A `SKILL_MARK` followed
 * by the name of a skill in `skillNames` becomes a skill node. Any other mark
 * stays in the text, for `restoreSkillMarks`. No text node is empty. Returns an
 * empty array for an empty text.
 */
export const splitMarkedSkillReferences = (
  text: string,
  skillNames: ReadonlySet<string>,
): MarkdownInline[] => {
  const parts: MarkdownInline[] = [];
  let from = 0;
  for (
    let mark = text.indexOf(SKILL_MARK);
    mark !== -1;
    mark = text.indexOf(SKILL_MARK, mark + 1)
  ) {
    const name = readSkillReferenceName(text, mark + 1);
    if (name === undefined || !skillNames.has(name)) continue;
    if (mark > from) parts.push({ type: "text", text: text.slice(from, mark) });
    parts.push({ type: "skill", name });
    from = mark + 1 + name.length;
  }
  if (from < text.length) parts.push({ type: "text", text: text.slice(from) });
  return parts;
};

/** Returns `value` with `$` in place of every `SKILL_MARK` in any string inside it. */
const restoreMarks = (value: unknown): unknown => {
  if (typeof value === "string") return value.replaceAll(SKILL_MARK, "$");
  if (Array.isArray(value)) return value.map(restoreMarks);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, restoreMarks(each)]),
    );
  }
  return value;
};

/**
 * Returns `document` with every `SKILL_MARK` left in it turned back into the
 * `$` it replaced. It walks every string field, so no mark leaks into a link
 * address, alt text, code or a text that did not become a chip.
 */
export const restoreSkillMarks = (document: MarkdownDocument): MarkdownDocument =>
  restoreMarks(document) as MarkdownDocument;
