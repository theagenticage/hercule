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
import {
  describeFileError,
  readFolderEntries,
  resolveWithinCheckout,
  shortenText,
  type ListingBudget,
  type ReachedPath,
} from "./files";

/** The deepest folder, counted from the skill folder at level 0, that the check enters. */
export const MAX_SKILL_FOLDER_DEPTH = 8;

/** The most files and folders the check looks at in one skill folder, its `SKILL.md` included. */
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
 * absolute and have no links in them, and `skillFolderIdentity` is the
 * identity `resolveWithinCheckout` returned for `skillFolder`.
 *
 * Every file and folder looked at is spent from `budget`, which the whole
 * listing shares. When none is left the check stops and returns
 * `budgetSpent`.
 *
 * The skill is refused when the folder:
 *
 * - holds a link that is refused by `resolveWithinCheckout` (an absolute
 *   target, too many links, or a way out of `checkoutPath`; nothing outside
 *   `checkoutPath` is touched), or a link that cannot be followed;
 * - holds a file or folder named `SKILL.md` in any letter case below its top
 *   level, which a harness would load as a second skill;
 * - holds more than `MAX_SKILL_FOLDER_ENTRIES` files and folders, or folders
 *   nested more than `MAX_SKILL_FOLDER_DEPTH` deep, so the check is bounded.
 *
 * Links that stay inside the checkout are followed, because a harness follows
 * them too. A folder reached twice is read once, which also ends a link loop.
 * "Twice" means the same folder in the file system (`identity`), not the same
 * spelling: on a file system that ignores letter case, `DEMO` and `demo` are
 * one folder.
 *
 * Every folder and link found here is resolved again with
 * `resolveWithinCheckout` before it is entered, because the folder listing
 * that named it may be out of date: a folder can have been replaced by a link
 * out of the checkout since it was listed.
 *
 * The top level `SKILL.md` is the skill's own and is not checked here. Throws
 * a file system error when a folder cannot be read, and the abort reason of
 * `budget.signal` when the time is over.
 */
export const findSkillFolderProblem = async (
  skillFolder: string,
  checkoutPath: string,
  budget: ListingBudget,
  skillFolderIdentity: string,
): Promise<SkillFolderProblem | undefined> => {
  const visited = new Set<string>([skillFolderIdentity]);
  let entryCount = 0;

  const check = async (
    folder: string,
    level: number,
    shownFolder: string,
  ): Promise<SkillFolderProblem | undefined> => {
    const { entries, stoppedBy } = await readFolderEntries(
      folder,
      budget,
      MAX_SKILL_FOLDER_ENTRIES - entryCount,
    );
    if (stoppedBy === "budget") return { budgetSpent: true };
    if (stoppedBy === "limit") {
      return { refusal: `holds more than ${String(MAX_SKILL_FOLDER_ENTRIES)} files and folders` };
    }
    entryCount += entries.length;
    for (const child of entries) {
      const shown = shownFolder === "" ? child.name : `${shownFolder}/${child.name}`;
      // The top level `SKILL.md` is the skill's own.
      if (level === 0 && child.name === "SKILL.md") continue;
      if (level > 0 && child.name.toLowerCase() === "skill.md") {
        return { refusal: `holds a second skill, ${quote(shown)}` };
      }
      // A plain file is not entered. A folder or link is resolved, not trusted: see above.
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      let entered: ReachedPath;
      try {
        const resolved = await resolveWithinCheckout(checkoutPath, folder, child.name, budget);
        if ("budgetSpent" in resolved) return resolved;
        if ("problem" in resolved) {
          return { refusal: `holds the link ${quote(shown)}, which ${resolved.problem}` };
        }
        entered = resolved;
      } catch (error) {
        budget.signal.throwIfAborted();
        return {
          refusal: `holds the link ${quote(shown)}, which cannot be followed: ${describeFileError(error)}`,
        };
      }
      if (!entered.isFolder || visited.has(entered.identity)) continue;
      visited.add(entered.identity);
      if (level + 1 > MAX_SKILL_FOLDER_DEPTH) {
        return { refusal: `is nested more than ${String(MAX_SKILL_FOLDER_DEPTH)} folders deep` };
      }
      const problem = await check(entered.path, level + 1, shown);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };

  return check(skillFolder, 0, "");
};
