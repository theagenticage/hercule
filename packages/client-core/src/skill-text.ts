import { findSkillReferences } from "@hercule/contract";

/** A stretch of a text that is either plain text or a skill the text references. */
export type SkillTextPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "skill"; readonly name: string };

/**
 * Splits `text` into plain text and skill parts, in text order. Returns an
 * empty array for an empty text.
 *
 * A Skill Reference (`$review`, `$webshop:release`) becomes a skill part only
 * when its name is in `skillNames`. Every other `$name` stays in the text
 * around it, so a typo or a deleted skill is drawn as written. Two text parts
 * are never side by side, and no text part is empty. References are found with
 * `findSkillReferences`, so code in the text is left alone.
 *
 * `startsAtBoundary` says whether the first character of `text` follows
 * whitespace or the start of a message. When it is false, a reference at index
 * 0 stays text: the text is the continuation of a word or of markup such as
 * `**a**`, and the runner does not read a `$` there as a reference. It
 * defaults to true.
 */
export const splitSkillReferences = (
  text: string,
  skillNames: ReadonlySet<string>,
  startsAtBoundary = true,
): ReadonlyArray<SkillTextPart> => {
  const parts: SkillTextPart[] = [];
  let cursor = 0;
  for (const reference of findSkillReferences(text)) {
    if (!skillNames.has(reference.name)) continue;
    if (reference.start === 0 && !startsAtBoundary) continue;
    if (reference.start > cursor) {
      parts.push({ type: "text", text: text.slice(cursor, reference.start) });
    }
    parts.push({ type: "skill", name: reference.name });
    cursor = reference.end;
  }
  if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts;
};

/**
 * Checks whether `text` holds any Skill Reference, whatever skills exist. A
 * caller uses it to skip reading a session's skills for a text that could not
 * show a chip. When it returns false, `splitSkillReferences` returns the text
 * as one text part.
 */
export const containsSkillReference = (text: string): boolean =>
  findSkillReferences(text).length > 0;
