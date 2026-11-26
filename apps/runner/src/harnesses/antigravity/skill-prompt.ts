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
 * Returns the message text to send `agy` for an input, and the Skill
 * References that text translated. The caller records them on the
 * `user_message` item and logs the skills that got no line.
 *
 * - An input without references returns exactly `buildHarnessPrompt(input)`.
 * - An input whose text starts with `/` is sent as typed, so `agy` runs it as
 *   its own slash command, whatever references it has.
 * - Otherwise the prompt `buildHarnessPrompt` builds is followed by a blank
 *   line and one pointer line per skill, in the order of first reference. The
 *   `$name` tokens stay in the text as typed. When the prompt is empty, the
 *   pointer lines are the whole message.
 *
 * A skill gets no line, and none of its references is returned, when
 * `resolveSkillFile` finds no usable `SKILL.md` for it.
 *
 * The lines point at the exact file instead of using `agy`'s own `/name`
 * command. `agy` turns `/name` into the same note for the model with a path,
 * but it picks that path itself, and it may list a built-in or a native
 * workspace skill under that name. A pointer names the skill Hercule resolved.
 */
export const buildAgyPrompt = (
  input: AdapterTurnInput,
): { readonly text: string; readonly translated: ReadonlyArray<ResolvedSkillReference> } => {
  const prompt = buildHarnessPrompt(input);
  const references = input.skillReferences ?? [];
  if (references.length === 0 || input.text.startsWith("/")) {
    return { text: prompt, translated: [] };
  }
  // One entry per skill folder, in the order of first reference. A skill whose
  // file is not found is left out.
  const skillFiles = new Map<string, string>();
  const pointers: Array<string> = [];
  for (const reference of references) {
    if (skillFiles.has(reference.folder)) continue;
    const skillFile = resolveSkillFile(reference.folder);
    if (skillFile === undefined) continue;
    skillFiles.set(reference.folder, skillFile);
    pointers.push(buildSkillPointer(reference, skillFile));
  }
  const translated = references.filter((reference) => skillFiles.has(reference.folder));
  if (pointers.length === 0) return { text: prompt, translated };
  const lines = pointers.join("\n");
  return { text: prompt === "" ? lines : `${prompt}\n\n${lines}`, translated };
};
