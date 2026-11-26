/**
 * Builds the prompt text `agy` gets for an input that carries Skill
 * References (spec 06 section 9.4, "Composer rules").
 */
import { resolveSkillFile, type ResolvedSkillReference } from "../../skills";
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
 * that text translated, and the names of the references that got no line. The
 * caller records the translated ones on the `user_message` item and tells the
 * user about the skipped ones.
 *
 * - An input without references returns exactly `buildHarnessPrompt(input)`.
 * - A prompt that starts with `/` is sent as typed, so `agy` runs it as its
 *   own slash command, whatever references the input has. The test is on the
 *   built prompt, because that is what `agy` reads: an input another session
 *   sent starts with a sender header, so `agy` does not take it as a command
 *   and its references get their lines.
 * - Otherwise the prompt `buildHarnessPrompt` builds is followed by a blank
 *   line and one pointer line per skill, in the order of first reference. The
 *   `$name` tokens stay in the text as typed. When the prompt is empty, the
 *   pointer lines are the whole message.
 *
 * A skill gets no line, and none of its references is translated, when
 * `resolveSkillFile` finds no usable `SKILL.md` for it. Its `referenceName`
 * is then in `skipped`, once, in order of first reference. `skipped` is empty
 * for an input without references and for a prompt that starts with `/`, which
 * translates nothing on purpose.
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
  readonly translated: ReadonlyArray<ResolvedSkillReference>;
  readonly skipped: ReadonlyArray<string>;
} => {
  const prompt = buildHarnessPrompt(input);
  const references = input.skillReferences ?? [];
  if (references.length === 0 || prompt.startsWith("/")) {
    return { text: prompt, translated: [], skipped: [] };
  }
  // One pass, in the order of first reference. A skill folder is looked up
  // once, even when the text names it again. A folder has one reference name,
  // so a skipped name also marks the later tokens of that skill.
  const seenFolders = new Set<string>();
  const pointers: Array<string> = [];
  const translated: Array<ResolvedSkillReference> = [];
  const skipped = new Set<string>();
  for (const reference of references) {
    if (!seenFolders.has(reference.folder)) {
      seenFolders.add(reference.folder);
      const skillFile = resolveSkillFile(reference.folder);
      if (skillFile === undefined) skipped.add(reference.referenceName);
      else pointers.push(buildSkillPointer(reference, skillFile));
    }
    if (!skipped.has(reference.referenceName)) translated.push(reference);
  }
  const result = { translated, skipped: [...skipped] };
  if (pointers.length === 0) return { text: prompt, ...result };
  const lines = pointers.join("\n");
  return { text: prompt === "" ? lines : `${prompt}\n\n${lines}`, ...result };
};
