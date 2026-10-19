/**
 * Resolves the Skill References in a message against the skills a session
 * process actually has loaded, so every adapter translates the same references
 * (spec 06 section 9.4, "Composer rules").
 *
 * The grammar of a reference lives in `@hercule/protocol`
 * (`findSkillReferences`). This file only decides which tokens name a skill of
 * the session.
 */
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
