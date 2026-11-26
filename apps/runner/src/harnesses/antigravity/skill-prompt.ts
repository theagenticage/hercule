/**
 * Builds the prompt text `agy` gets for an input that carries Skill
 * References (spec 06 section 9.4, "Composer rules").
 */
import { resolveSkillFiles, type ResolvedSkillReference } from "../../skills";
import type { AdapterTurnInput } from "../index";
import { buildHarnessPrompt } from "../prompt";

/**
 * Returns the line that tells the model to read one skill. The path is a JSON
 * string, so a path with spaces or control characters stays one token.
 */
const buildSkillPointer = (reference: ResolvedSkillReference, skillFile: string): string =>
  `[Skill "$${reference.referenceName}": read and use the skill at ${JSON.stringify(skillFile)}.]`;

/**
 * Returns the message text to send `agy` for an input, the Skill References
 * that text translated, and the names of the skills that got no line. The
 * caller records the translated references on the `user_message` item and
 * tells the user about the skipped skills.
 *
 * The prompt `buildHarnessPrompt` builds always comes first and unchanged, so
 * a slash command the user typed stays one for `agy`, and a text that merely
 * starts with a path keeps its meaning. It is followed by a blank line and one
 * pointer line per skill, in the order of first reference. The `$name` tokens
 * stay in the text as typed. When the prompt is empty, the pointer lines are
 * the whole message. An input without references returns exactly
 * `buildHarnessPrompt(input)`.
 *
 * A skill gets no line, and none of its references is translated, when
 * `resolveSkillFiles` finds no usable `SKILL.md` for it. Its `referenceName`
 * is then in `skipped`, once, in order of first reference.
 *
 * The lines point at the exact file instead of using `agy`'s own `/name`
 * command. `agy` turns `/name` into the same note for the model with a path,
 * but it picks that path itself, and it may list a built-in or a native
 * workspace skill under that name. A pointer names the skill Hercule resolved.
 */
export const buildAgyPrompt = (
  input: AdapterTurnInput,
): {
  readonly text: string;
  readonly skillReferences: ReadonlyArray<ResolvedSkillReference>;
  readonly skipped: ReadonlyArray<string>;
} => {
  const prompt = buildHarnessPrompt(input);
  const { found, skipped } = resolveSkillFiles(input.skillReferences ?? []);
  const skillReferences = found.map(({ reference }) => reference);
  if (found.length === 0) return { text: prompt, skillReferences, skipped };
  const lines = found.map(({ reference, skillFile }) => buildSkillPointer(reference, skillFile));
  return {
    text: prompt === "" ? lines.join("\n") : `${prompt}\n\n${lines.join("\n")}`,
    skillReferences,
    skipped,
  };
};
