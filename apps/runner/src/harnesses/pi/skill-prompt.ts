/**
 * Builds the prompt text pi gets for an input that carries Skill References
 * (spec 06 section 9.4, "Composer rules").
 *
 * pi has no skill tool. It expands a skill itself in one case only: the
 * message text starts with `/skill:<name> `, and `<name>` is a skill pi
 * loaded. Anything else about a skill is the model's choice: pi lists the
 * skills in its system prompt and the model reads a `SKILL.md` with its `read`
 * tool when it decides to. So each input gets two translations:
 *
 * - the first reference that names a skill pi runs under its bare name becomes
 *   the leading `/skill:<name>` command;
 * - every other referenced skill gets a line after the prompt that gives the
 *   path of its `SKILL.md` and asks the model to read it.
 */
import { lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { AdapterTurnInput } from "../index";
import { buildHarnessPrompt } from "../prompt";
import { resolveSkillFile, type ResolvedSkillReference } from "../../skills/references";

/**
 * Returns the folder of the skill pi loads under `name`, or undefined when
 * none of `stagedFolders` holds one. pi loads the folders in order and keeps
 * the first skill of a name, so the first folder that has `skills/<name>`
 * wins. A repository skill is staged as a symbolic link, so the folder it
 * points to is returned, which is the checkout's own folder. Both kinds of
 * folder then compare equal to `ResolvedSkillReference.folder`.
 *
 * The name pi gives a skill is its frontmatter name, or its folder name when
 * it has none. The runner refuses a skill whose two differ, so the bare skill
 * name is also the name pi uses.
 */
const findLoadedSkillFolder = (
  stagedFolders: ReadonlyArray<string>,
  name: string,
): string | undefined => {
  for (const staged of stagedFolders) {
    const path = join(staged, "skills", name);
    try {
      return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : path;
    } catch {
      // This folder has no skill of that name; the next folder may.
    }
  }
  return undefined;
};

/**
 * Returns `text` without the token of `reference`. The spaces and tabs around
 * the token go with it, so "run $review now" becomes "run now" and a token
 * that opened the text leaves no blank space at the start.
 */
const removeReference = (text: string, reference: ResolvedSkillReference): string => {
  const before = text.slice(0, reference.start).replace(/[ \t]+$/, "");
  const after = text.slice(reference.end);
  if (before === "") return after.trimStart();
  return before.endsWith("\n") ? before + after.replace(/^[ \t]+/, "") : before + after;
};

/**
 * Returns the line that points the model at a skill pi does not run itself,
 * or undefined when `resolveSkillFile` finds no usable `SKILL.md` for it. It
 * has the same bracket form as the line for an attached image.
 */
const buildSkillPointer = (reference: ResolvedSkillReference): string | undefined => {
  const skillFile = resolveSkillFile(reference.folder);
  return skillFile === undefined
    ? undefined
    : `[Skill "$${reference.referenceName}" is at ${skillFile}. Read it with the read tool and follow it.]`;
};

/**
 * Returns the message text to send pi for an input, and the names of the
 * skills that got a pointer line in no form: their `SKILL.md` is missing or
 * leads outside the skill's folder. The caller tells the user about those. The
 * leading `/skill:<name>` command needs no file check, because pi loaded that
 * skill itself. An input without Skill References gets exactly
 * `buildHarnessPrompt(input)` and skips nothing.
 *
 * With references, the message is built from these parts:
 *
 * - `/skill:<name>` and a space, for the first reference whose skill pi runs
 *   under its bare name (see `findLoadedSkillFolder`). A skill loses its name
 *   to another skill of the same name that pi loads first, such as a library
 *   `release` and a repository `webshop:release`. That one is then no
 *   candidate, and the next reference may lead instead. The token of the
 *   leading skill is removed from the text.
 * - the prompt `buildHarnessPrompt` builds: sender header, text, image lines;
 * - one pointer line for each other skill that has a usable `SKILL.md`, once
 *   per skill, in text order. The `$name` tokens of those skills stay in the
 *   text as typed, also when the skill gets no line. A second token
 *   of the leading skill stays in the text and gets no pointer, because pi
 *   already expanded that skill.
 *
 * `stagedFolders` are the folders pi was started with `--skill`, in the order
 * it got them: the library skills folder, then the repository skills folders.
 *
 * pi expands a leading `/skill:` in a steering message as well, so this text
 * is right for an input that opens a turn and one that steers it.
 */
export const buildPiPrompt = (
  input: AdapterTurnInput,
  stagedFolders: ReadonlyArray<string>,
): { readonly text: string; readonly skipped: ReadonlyArray<string> } => {
  const references = input.skillReferences ?? [];
  if (references.length === 0) return { text: buildHarnessPrompt(input), skipped: [] };
  // One skill is referenced by one name, so the first token of each name is
  // enough to decide the leading skill and to build the pointers. This keeps
  // the folder lookups to one per skill, however often the text repeats it.
  const firstTokens = new Map<string, ResolvedSkillReference>();
  for (const reference of references) {
    if (!firstTokens.has(reference.referenceName)) {
      firstTokens.set(reference.referenceName, reference);
    }
  }
  const leading = [...firstTokens.values()].find(
    (reference) => findLoadedSkillFolder(stagedFolders, reference.skillName) === reference.folder,
  );
  const prompt = buildHarnessPrompt(
    input,
    leading === undefined ? input.text : removeReference(input.text, leading),
  );
  const lines: Array<string> = [];
  const skipped: Array<string> = [];
  for (const reference of firstTokens.values()) {
    if (reference === leading) continue;
    const line = buildSkillPointer(reference);
    if (line === undefined) skipped.push(reference.referenceName);
    else lines.push(line);
  }
  const pointers = lines.join("\n");
  const body = pointers === "" ? prompt : prompt === "" ? pointers : `${prompt}\n\n${pointers}`;
  if (leading === undefined) return { text: body, skipped };
  const command = `/skill:${leading.skillName}`;
  return { text: body === "" ? command : `${command} ${body}`, skipped };
};
