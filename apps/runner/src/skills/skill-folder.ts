/**
 * Checks everything inside a repository skill's folder before the runner
 * offers the skill (spec 06 section 9.4).
 *
 * A harness does not only load the `SKILL.md` it is pointed at. Codex scans an
 * extra skills root recursively and follows links, so it also loads a skill
 * nested inside an accepted one that the listing never shows, and every skill
 * behind a link in the folder, such as the user's own `~/.claude/skills`.
 * Every harness gets the same rule, so a skill means the same on each of them.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  compareNames,
  describeFileError,
  findLinkTargetProblem,
  isInside,
  shortenText,
  spendEntry,
  type ListingBudget,
} from "./files";

/** The deepest folder, counted from the skill folder at level 0, that the check enters. */
export const MAX_SKILL_FOLDER_DEPTH = 8;

/** The most files and folders the check looks at in one skill folder. */
export const MAX_SKILL_FOLDER_ENTRIES = 1000;

/** The most characters of a path inside a skill folder that a reason quotes. */
const MAX_QUOTED_PATH_LENGTH = 64;

const quote = (path: string): string => `\`${shortenText(path, MAX_QUOTED_PATH_LENGTH)}\``;

/**
 * What the check found when it did not accept the folder: the reason to refuse
 * the skill, or the news that the listing's budget ran out before the check
 * could finish, so the skill is neither accepted nor known to be bad.
 */
export type SkillFolderProblem = { readonly refusal: string } | { readonly budgetSpent: true };

/**
 * Checks the files and folders inside `skillFolder` and returns what keeps the
 * skill from being offered, or undefined when the folder is fine. A refusal
 * is a clause that follows "its folder". `skillFolder` and `checkoutPath` are
 * absolute and have no links in them.
 *
 * Every file and folder looked at is spent from `budget`, which the whole
 * listing shares. When none is left the check stops and returns
 * `budgetSpent`.
 *
 * The skill is refused when the folder:
 *
 * - holds a link whose target, read as text, is absolute or leaves
 *   `checkoutPath` (the target is not touched), or a link that resolves
 *   outside `checkoutPath` or cannot be resolved;
 * - holds a file or folder named `SKILL.md` in any letter case below its top
 *   level, which a harness would load as a second skill;
 * - holds more than `MAX_SKILL_FOLDER_ENTRIES` files and folders, or folders
 *   nested more than `MAX_SKILL_FOLDER_DEPTH` deep, so the check is bounded.
 *
 * Links that stay inside the checkout are followed, because a harness follows
 * them too. A folder reached twice is read once, which also ends a link loop.
 *
 * The top level `SKILL.md` is the skill's own and is not checked here. Throws
 * a file system error when a folder cannot be read, and the abort reason of
 * `budget.signal` when the time is over.
 */
export const findSkillFolderProblem = async (
  skillFolder: string,
  checkoutPath: string,
  budget: ListingBudget,
): Promise<SkillFolderProblem | undefined> => {
  const visited = new Set<string>([skillFolder]);
  let entryCount = 0;

  const check = async (
    folder: string,
    level: number,
    shownFolder: string,
  ): Promise<SkillFolderProblem | undefined> => {
    const children = await readdir(folder, { withFileTypes: true });
    children.sort((a, b) => compareNames(a.name, b.name));
    for (const child of children) {
      const shown = shownFolder === "" ? child.name : `${shownFolder}/${child.name}`;
      // The top level `SKILL.md` is the skill's own.
      if (level === 0 && child.name === "SKILL.md") continue;
      if (!spendEntry(budget)) return { budgetSpent: true };
      entryCount += 1;
      if (entryCount > MAX_SKILL_FOLDER_ENTRIES) {
        return { refusal: `holds more than ${String(MAX_SKILL_FOLDER_ENTRIES)} files and folders` };
      }
      if (level > 0 && child.name.toLowerCase() === "skill.md") {
        return { refusal: `holds a second skill, ${quote(shown)}` };
      }
      let real = join(folder, child.name);
      let isFolder = child.isDirectory();
      if (child.isSymbolicLink()) {
        // The target is read as text before anything follows it.
        const textProblem = await findLinkTargetProblem(real, checkoutPath).catch(
          (error: unknown) => `cannot be followed: ${describeFileError(error)}`,
        );
        if (textProblem !== undefined) {
          return { refusal: `holds the link ${quote(shown)}, which ${textProblem}` };
        }
        try {
          real = await realpath(real);
          isFolder = (await stat(real)).isDirectory();
        } catch (error) {
          return {
            refusal: `holds the link ${quote(shown)}, which cannot be followed: ${describeFileError(error)}`,
          };
        }
        if (!isInside(checkoutPath, real)) {
          return { refusal: `holds the link ${quote(shown)}, which leads outside its checkout` };
        }
      }
      if (!isFolder || visited.has(real)) continue;
      visited.add(real);
      if (level + 1 > MAX_SKILL_FOLDER_DEPTH) {
        return { refusal: `is nested more than ${String(MAX_SKILL_FOLDER_DEPTH)} folders deep` };
      }
      const problem = await check(real, level + 1, shown);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };

  return check(skillFolder, 0, "");
};
