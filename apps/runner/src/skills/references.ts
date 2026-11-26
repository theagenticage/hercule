/**
 * Resolves the Skill References in a message against the skills a session
 * process actually has loaded, so every adapter translates the same references
 * (spec 06 section 9.4, "Composer rules").
 *
 * The grammar of a reference lives in `@hercule/protocol`
 * (`findSkillReferences`). This file only decides which tokens name a skill of
 * the session.
 */
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { findSkillReferences } from "@hercule/protocol";
import type { ListedRepositorySkill } from "./repository";

/** A skill of the Skill Library, as the session's process loaded it. */
interface LoadedLibrarySkill {
  readonly source: "library";
  /** The Skill's name, which is also its folder name. */
  readonly skillName: string;
  /** The skill's folder inside the start's library skills folder. */
  readonly folder: string;
}

/** A skill of a checkout, as the session's process loaded it. */
interface LoadedRepositorySkill {
  readonly source: "repository";
  /** The skill's folder name in its checkout, such as `release`. */
  readonly skillName: string;
  /** The skill prefix of the checkout, such as `webshop`. */
  readonly checkoutName: string;
  /** The skill's real folder in the checkout, not the staged link to it. */
  readonly folder: string;
}

/** A skill that the session's process loaded when it started. */
export type LoadedSkill = LoadedLibrarySkill | LoadedRepositorySkill;

/**
 * The skills a session's process loaded at its start, by the name a message
 * uses to reference them: `review` for a library skill, `webshop:release` for
 * a repository skill. A skill added to a checkout after the start is not in it.
 */
export type LoadedSkills = ReadonlyMap<string, LoadedSkill>;

/** One Skill Reference in a message that names a loaded skill. */
export type ResolvedSkillReference = LoadedSkill & {
  /** The reference without the `$`, as typed: `review` or `webshop:release`. */
  readonly referenceName: string;
  /** The index of the `$` in the message text. */
  readonly start: number;
  /** The index just past the last character of the reference in the message text. */
  readonly end: number;
};

/**
 * Builds the skills of a session's process, from what the runner gave it at
 * its start. `libraryFolder` is the library skills folder, with the skills of
 * `libraryNames` in `<libraryFolder>/skills/<name>`. `repositorySkills` are
 * the repository skills staged for the process.
 *
 * Both lists are exactly what the harness loaded, so a skill that is in
 * neither is never resolved.
 */
export function buildLoadedSkills(options: {
  readonly libraryFolder: string | undefined;
  readonly libraryNames: ReadonlyArray<string>;
  readonly repositorySkills: ReadonlyArray<
    Pick<ListedRepositorySkill, "checkoutName" | "name" | "absolutePath">
  >;
}): LoadedSkills {
  const loaded = new Map<string, LoadedSkill>();
  if (options.libraryFolder !== undefined) {
    for (const name of options.libraryNames) {
      loaded.set(name, {
        source: "library",
        skillName: name,
        folder: join(options.libraryFolder, "skills", name),
      });
    }
  }
  for (const skill of options.repositorySkills) {
    loaded.set(`${skill.checkoutName}:${skill.name}`, {
      source: "repository",
      skillName: skill.name,
      checkoutName: skill.checkoutName,
      folder: skill.absolutePath,
    });
  }
  return loaded;
}

/**
 * Returns the Skill References in `text` that name a loaded skill, in the order
 * they appear. A token that names no loaded skill (`$reveiw`, or a repository
 * skill added after the session started) is plain text and is left out.
 *
 * A skill referenced twice appears twice, once per token, because each token
 * has its own place in the text. The caller decides whether to translate every
 * occurrence or the first only.
 */
export function resolveSkillReferences(
  text: string,
  loaded: LoadedSkills,
): ReadonlyArray<ResolvedSkillReference> {
  const resolved: Array<ResolvedSkillReference> = [];
  for (const { name, start, end } of findSkillReferences(text)) {
    const skill = loaded.get(name);
    if (skill !== undefined) resolved.push({ ...skill, referenceName: name, start, end });
  }
  return resolved;
}

/**
 * Returns the real path of `<folder>/SKILL.md`, with every symbolic link
 * resolved. Returns undefined when the file does not exist, when it is not a
 * regular file (a folder named `SKILL.md`, for example), or when it resolves
 * to a file outside the real `folder`, such as a `SKILL.md` that is a link to
 * another file the user can read. A skill folder that is itself a symbolic
 * link is fine, because the file is compared with the resolved folder.
 *
 * `resolveSkillFiles` calls this for every skill folder an input names, so
 * an adapter never points a harness at a path outside the skill.
 */
export function resolveSkillFile(folder: string): string | undefined {
  try {
    const path = realpathSync(join(folder, "SKILL.md"));
    if (path !== join(realpathSync(folder), "SKILL.md")) return undefined;
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/** A skill folder the references name, with the checked path of its `SKILL.md`. */
export interface FoundSkillFile {
  /** The first reference to the skill folder in the message. */
  readonly reference: ResolvedSkillReference;
  /** The real path `resolveSkillFile` returned for the folder. */
  readonly skillFile: string;
}

/**
 * Checks the skill file of every distinct skill folder the `references` name,
 * so every adapter points its harness at the same files. Returns:
 *
 * - `found`: one entry per skill folder, in order of first reference, with
 *   the first reference to it and the real path `resolveSkillFile` returned;
 * - `skipped`: the `referenceName` of each skill folder whose file
 *   `resolveSkillFile` rejects, in order of first reference.
 *
 * A folder is checked once, however many tokens name it. A folder has one
 * reference name, so a skipped name also covers the later tokens of that skill.
 */
export function resolveSkillFiles(references: ReadonlyArray<ResolvedSkillReference>): {
  readonly found: ReadonlyArray<FoundSkillFile>;
  readonly skipped: ReadonlyArray<string>;
} {
  const seenFolders = new Set<string>();
  const found: Array<FoundSkillFile> = [];
  const skipped: Array<string> = [];
  for (const reference of references) {
    if (seenFolders.has(reference.folder)) continue;
    seenFolders.add(reference.folder);
    const skillFile = resolveSkillFile(reference.folder);
    if (skillFile === undefined) skipped.push(reference.referenceName);
    else found.push({ reference, skillFile });
  }
  return { found, skipped };
}
