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
import { describeFileError, isInside } from "./files";

/** The deepest folder, counted from the skill folder at level 0, that the check enters. */
export const MAX_SKILL_FOLDER_DEPTH = 8;

/** The most files and folders the check looks at in one skill folder. */
export const MAX_SKILL_FOLDER_ENTRIES = 1000;

/** The most characters of a path inside a skill folder that a reason quotes. */
const MAX_QUOTED_PATH_LENGTH = 64;

const quote = (path: string): string => {
  const characters = Array.from(path);
  return characters.length <= MAX_QUOTED_PATH_LENGTH
    ? `\`${path}\``
    : `\`${characters.slice(0, MAX_QUOTED_PATH_LENGTH).join("")}...\``;
};

/**
 * Checks the files and folders inside `skillFolder` and returns the reason the
 * skill cannot be offered, or undefined when the folder is fine. The reason
 * is a clause that follows "its folder". `skillFolder` and `checkoutPath` are
 * absolute and have no links in them.
 *
 * The skill is refused when the folder:
 *
 * - holds a link that resolves outside `checkoutPath`, or a link that cannot
 *   be resolved;
 * - holds a file or folder named `SKILL.md` in any letter case below its top
 *   level, which a harness would load as a second skill;
 * - holds more than `MAX_SKILL_FOLDER_ENTRIES` files and folders, or folders
 *   nested more than `MAX_SKILL_FOLDER_DEPTH` deep, so the check is bounded.
 *
 * Links that stay inside the checkout are followed, because a harness follows
 * them too. A folder reached twice is read once, which also ends a link loop.
 *
 * The top level `SKILL.md` is the skill's own and is not checked here. Throws
 * a file system error when a folder cannot be read.
 */
export const findSkillFolderProblem = async (
  skillFolder: string,
  checkoutPath: string,
): Promise<string | undefined> => {
  const visited = new Set<string>([skillFolder]);
  let entryCount = 0;

  const check = async (
    folder: string,
    level: number,
    shownFolder: string,
  ): Promise<string | undefined> => {
    const children = await readdir(folder, { withFileTypes: true });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const shown = shownFolder === "" ? child.name : `${shownFolder}/${child.name}`;
      // The top level `SKILL.md` is the skill's own.
      if (level === 0 && child.name === "SKILL.md") continue;
      entryCount += 1;
      if (entryCount > MAX_SKILL_FOLDER_ENTRIES) {
        return `holds more than ${String(MAX_SKILL_FOLDER_ENTRIES)} files and folders`;
      }
      if (level > 0 && child.name.toLowerCase() === "skill.md") {
        return `holds a second skill, ${quote(shown)}`;
      }
      let real = join(folder, child.name);
      let isFolder = child.isDirectory();
      if (child.isSymbolicLink()) {
        try {
          real = await realpath(real);
          isFolder = (await stat(real)).isDirectory();
        } catch (error) {
          return `holds the link ${quote(shown)}, which cannot be followed: ${describeFileError(error)}`;
        }
        if (!isInside(checkoutPath, real)) {
          return `holds the link ${quote(shown)}, which leads outside its checkout`;
        }
      }
      if (!isFolder || visited.has(real)) continue;
      visited.add(real);
      if (level + 1 > MAX_SKILL_FOLDER_DEPTH) {
        return `is nested more than ${String(MAX_SKILL_FOLDER_DEPTH)} folders deep`;
      }
      const problem = await check(real, level + 1, shown);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };

  return check(skillFolder, 0, "");
};
