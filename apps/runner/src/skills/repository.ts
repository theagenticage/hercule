/**
 * Lists the repository skills of a workspace: the skill folders in the
 * `.agents/skills` and `.claude/skills` folders of each checkout (spec 06
 * section 9.4).
 *
 * The runner reads the folders live from the checkouts. It copies nothing and
 * keeps no state, so a skill the user adds to a checkout shows up in the next
 * listing.
 *
 * This file owns every rule of the listing: the order of the checkouts, which
 * folders are skills, the limits, and the name a checkout gives its skills.
 * A session that starts, an inspection of a running workspace and a preview of
 * a workspace that does not exist yet all call it, so they cannot disagree.
 *
 * A checkout is untrusted input: a repository can commit a symbolic link to
 * any place on the runner's disk, such as the user's own `~/.claude/skills`.
 * Links inside the checkout are fine and common (`.claude/skills` pointing at
 * `.agents/skills`). A skills folder, a skill folder, a `SKILL.md` or anything
 * inside a skill folder that resolves outside the checkout is refused.
 *
 * A link is judged by its target as text first (see `findLinkTargetProblem`),
 * so the runner never touches a place such as a stale network mount that a
 * repository links to. The whole listing also draws on one budget of files
 * and folders (`MAX_LISTING_ENTRIES`) and stops when it is spent.
 */
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  MAX_FACT_LENGTH,
  MAX_REPOSITORY_SKILLS,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKIPPED_REASON_LENGTH,
  SkillName,
  canonicalizeRemote,
  extractRepoName,
  formatCheckoutName,
  type RepositorySkill,
  type RepositorySkillFolder,
  type SkippedRepositorySkill,
} from "@hercule/protocol";
import { describeError } from "../report";
import type { RegisteredCheckout } from "../workspaces/registry";
import {
  MAX_LISTING_ENTRIES,
  buildListingBudget,
  compareNames,
  describeFileError,
  findLinkProblemOnPath,
  findLinkTargetProblem,
  fitText,
  isInside,
  isMissing,
  shortenText,
  spendEntry,
  type ListingBudget,
} from "./files";
import { findSkillFolderProblem } from "./skill-folder";

/** The folders of a checkout that hold repository skills, in the order they win a name. */
const SKILL_FOLDERS: ReadonlyArray<RepositorySkillFolder> = [".agents/skills", ".claude/skills"];

/**
 * How much of a `SKILL.md` is read. The frontmatter is at the top of the
 * file, and a repository can hold a file of any size.
 */
const MAX_FRONTMATTER_BYTES = 64 * 1024;

/**
 * The most characters of a value the repository controls, such as a folder
 * name or a frontmatter `name`, that a reason quotes.
 */
const MAX_QUOTED_LENGTH = 64;

/**
 * Returns the reason a repo that has no ready main workspace on the runner
 * offers no skills. It names the repo, because a workspace of one repo has its
 * checkout at the root, whose path is only `.`.
 */
const describeNoMainWorkspace = (remote: string): string =>
  `the repo \`${shortenText(extractRepoName(canonicalizeRemote(remote) ?? remote), MAX_QUOTED_LENGTH)}\` has no ready main workspace on this runner; provision or attach its main workspace on this runner`;

/** The reason for the one folder where the listing ran out of files and folders to look at. */
const BUDGET_SPENT = `the listing looks at ${String(MAX_LISTING_ENTRIES)} files and folders at most; this folder and everything after it were not read`;

/**
 * Returns the reason a checkout's repository skills are skipped when another
 * checkout of the same workspace already has the skill prefix `checkoutName`
 * (see `formatCheckoutName`).
 */
const describeDuplicateCheckoutName = (checkoutName: string): string =>
  `checkout \`${checkoutName}\` has the same skill prefix as another checkout in this workspace`;

/**
 * The parts of a workspace that the listing reads: its directory and the place
 * of each checkout.
 */
export interface WorkspaceToList {
  readonly root: string;
  readonly checkouts: ReadonlyArray<Pick<RegisteredCheckout, "remote" | "path">>;
}

/** One checkout of a workspace, real or planned, whose skills are to be listed. */
export interface CheckoutToList {
  /** The remote of the checkout's repo, as the user wrote it. */
  readonly remote: string;
  /** Where the checkout sits in the workspace, or null when it is the workspace root. */
  readonly subdirectory: string | null;
  /** The folder to read, or null when the runner has no folder for this checkout. */
  readonly path: string | null;
}

/**
 * A repository skill with the absolute path of its folder, which only the
 * runner uses. The folder has no symbolic links left in it and lies inside its
 * checkout, so the runner can link to it without checking it again.
 */
export interface ListedRepositorySkill extends RepositorySkill {
  readonly absolutePath: string;
}

/**
 * What a workspace offers: the skills in order of checkout and then name, and
 * the folders and checkouts that cannot be offered, in the order the listing
 * found them. Each list holds at most `MAX_REPOSITORY_SKILLS` entries.
 * `truncated` is true when an entry is not shown in either list: the skipped
 * list was full when another folder needed a place in it, or the listing
 * stopped at its budget of files and folders (`MAX_LISTING_ENTRIES`) with
 * folders unread. A list that is exactly full, with nothing left out, is not
 * truncated. A valid skill past the 256th is shown as a skipped folder, so it
 * does not by itself make the listing truncated.
 */
export interface RepositorySkillListing {
  readonly skills: ReadonlyArray<ListedRepositorySkill>;
  readonly skipped: ReadonlyArray<SkippedRepositorySkill>;
  readonly truncated: boolean;
}

const isSkillName = Schema.is(SkillName);

/** Returns `text` cut to `MAX_QUOTED_LENGTH` characters, ending in `...` when it was cut. */
const shorten = (text: string): string => shortenText(text, MAX_QUOTED_LENGTH);

/**
 * Returns `text` with each control character written as `\u{...}`. Text the
 * repository controls would otherwise carry line breaks or direction marks
 * into a client's screen.
 */
const escapeControlCharacters = (text: string): string =>
  text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
  );

/** Builds a skipped entry whose path and reason fit the protocol's limits and carry no control characters. */
const buildSkipped = (path: string, reason: string): SkippedRepositorySkill => ({
  path: fitText(escapeControlCharacters(path), MAX_FACT_LENGTH),
  reason: fitText(escapeControlCharacters(reason), MAX_SKIPPED_REASON_LENGTH),
});

/**
 * Matches the control characters a description may not hold: the C0 and C1
 * controls and the bidirectional controls. Tab, line feed and carriage return
 * are removed before the match, because a description written as a YAML block
 * has line breaks.
 */
const FORBIDDEN_DESCRIPTION_CHARACTER = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** Describes a frontmatter value that is neither text nor empty, for the reason a `name` is refused. */
const describeKind = (value: unknown): string => {
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "number":
      return "a number";
    case "boolean":
      return "true or false";
    default:
      return "a mapping";
  }
};

/**
 * Parses the frontmatter of a `SKILL.md`: the text between the first two lines
 * that hold only `---`. Returns the description, or the reason this file
 * offers none. `textWasCut` says the text is only the start of a longer file.
 *
 * The reason is also:
 *
 * - a `name` that is not text, such as `name: 123`: Claude Code would load
 *   the skill as `123`, while the runner lists it under its folder name. An
 *   empty `name`, with no value or `""`, is the same as no name;
 * - a mismatch between the frontmatter `name` and `folderName`. The harnesses
 *   name a skill by its frontmatter `name` and fall back to the folder name,
 *   and the Agent Skills format requires the two to be equal, so a skill with
 *   different ones would have a name here that the harnesses do not use;
 * - a description with a control character, other than a line break or tab.
 *
 * A frontmatter without a `name` is accepted. The reason quotes at most
 * `MAX_QUOTED_LENGTH` characters of any name.
 */
export const parseSkillFrontmatter = (
  text: string,
  folderName: string,
  textWasCut = false,
): { description: string } | { problem: string } => {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (lines[0]?.trimEnd() !== "---") {
    return { problem: "its SKILL.md has no frontmatter between two `---` lines" };
  }
  if (end === -1) {
    return {
      problem: textWasCut
        ? `its frontmatter is longer than ${String(MAX_FRONTMATTER_BYTES / 1024)} KiB`
        : "its SKILL.md has no frontmatter between two `---` lines",
    };
  }
  let frontmatter: unknown;
  try {
    frontmatter = Bun.YAML.parse(lines.slice(1, end).join("\n"));
  } catch (error) {
    return {
      problem: `the frontmatter of its SKILL.md is not valid YAML: ${describeError(error)}`,
    };
  }
  const fields = typeof frontmatter === "object" && frontmatter !== null ? frontmatter : {};
  // `name:` with no value parses to null and counts as no name, like `name: ""`.
  const declaredName = "name" in fields && fields.name !== null ? fields.name : undefined;
  if (declaredName !== undefined && typeof declaredName !== "string") {
    return {
      problem: `its frontmatter name is ${describeKind(declaredName)}, not text; write it as text`,
    };
  }
  if (typeof declaredName === "string" && declaredName.trim() !== "") {
    if (declaredName.trim() !== folderName) {
      return {
        problem: `its frontmatter name \`${shorten(declaredName.trim())}\` differs from its folder name \`${shorten(folderName)}\`; the Agent Skills format requires them to match`,
      };
    }
  }
  const description = "description" in fields ? fields.description : undefined;
  if (typeof description !== "string" || description.trim() === "") {
    return { problem: "its SKILL.md has no description" };
  }
  const trimmed = description.trim();
  if (trimmed.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return {
      problem: `its description is ${String(trimmed.length)} characters, and the limit is ${String(MAX_SKILL_DESCRIPTION_LENGTH)}`,
    };
  }
  if (FORBIDDEN_DESCRIPTION_CHARACTER.test(trimmed.replace(/[\t\n\r]/g, ""))) {
    return { problem: "its description has a control character" };
  }
  return { description: trimmed };
};

/**
 * Reads the start of the `SKILL.md` in `skillFolder`. Returns its text, or the
 * reason the file cannot be used: it is missing, or it is a link to a file
 * outside `checkoutPath` (or a link with an absolute target), or it is not a
 * regular file. `cut` is true when the
 * file is longer than the text. Throws a file system error when the file
 * cannot be opened or read.
 *
 * The file is opened without waiting, then checked on the open handle. A named
 * pipe called `SKILL.md` would otherwise block the open forever.
 */
const readSkillMarkdown = async (
  skillFolder: string,
  checkoutPath: string,
): Promise<{ text: string; cut: boolean } | { problem: string }> => {
  const markdownPath = join(skillFolder, "SKILL.md");
  let path: string;
  try {
    // A link is judged by its target as text before anything follows it.
    if ((await lstat(markdownPath)).isSymbolicLink()) {
      const textProblem = await findLinkTargetProblem(markdownPath, checkoutPath);
      if (textProblem !== undefined) {
        return { problem: `its SKILL.md is a link that ${textProblem}` };
      }
    }
    path = await realpath(markdownPath);
  } catch (error) {
    if (isMissing(error)) return { problem: "its folder has no SKILL.md" };
    throw error;
  }
  if (!isInside(checkoutPath, path)) {
    return { problem: "its SKILL.md is a link to a file outside its checkout" };
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) return { problem: "its SKILL.md is not a regular file" };
    const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES);
    const { bytesRead } = await file.read(buffer, 0, MAX_FRONTMATTER_BYTES, 0);
    return { text: buffer.toString("utf8", 0, bytesRead), cut: stats.size > bytesRead };
  } finally {
    await file.close();
  }
};

/** How many more entries one checkout may add to each list of its workspace's listing. */
interface RemainingListSlots {
  readonly skills: number;
  readonly skipped: number;
}

/** One checkout whose folder has been found, ready to be read. */
interface CheckoutToRead {
  /** The checkout's folder, with its links resolved. */
  readonly path: string;
  /** The checkout's folder relative to the workspace root, or null for a checkout at the root. */
  readonly subdirectory: string | null;
  /** The prefix of the checkout's skills, or the reason it has none. */
  readonly prefix: { readonly name: string } | { readonly reason: string };
}

/**
 * Lists the skills of one checkout, in name order, and the folders it cannot
 * offer. Adds at most `slots.skills` skills and `slots.skipped` skipped
 * folders. `truncated` is true when an entry was left out, for lack of room in
 * a list or because `budget` ran out. Never fails: whatever cannot be read
 * becomes a skipped folder. Only the abort of `budget.signal` throws.
 *
 * Reading goes on after both lists are full, until an entry is left out,
 * because only that entry shows that the lists are cut. Each folder name is
 * checked against the skill name rule before the runner touches the folder, a
 * skill past the limit is not read, and the reading stops when nothing it
 * could still find would change the answer. A checkout with thousands of
 * folders therefore costs little.
 */
const listCheckoutSkills = async (
  checkout: CheckoutToRead,
  slots: RemainingListSlots,
  budget: ListingBudget,
): Promise<RepositorySkillListing> => {
  const skills: Array<ListedRepositorySkill> = [];
  const skipped: Array<SkippedRepositorySkill> = [];
  let truncated = false;
  // The skill name of each accepted skill, with its path for the "same name" reason.
  const pathsByName = new Map<string, string>();
  // The folder of each accepted skill, so a folder reached by two paths is listed once.
  const acceptedFolders = new Set<string>();
  // The same for a folder that was refused under a name, so it is reported once. The name is
  // part of the key: a folder that a link with a wrong name refuses is a fine skill under its own.
  const refusedFolders = new Set<string>();
  // The skills folders already read, so a link to a skills folder does not list it twice.
  const readFolders = new Set<string>();

  // A path from the workspace root. A skipped skill is named by it, and so is a listed one.
  const describePath = (folder: string, name?: string): string =>
    [checkout.subdirectory, folder, name === undefined ? undefined : shorten(name)]
      .filter((part) => part !== undefined && part !== null)
      .join("/");
  const skip = (path: string, reason: string): void => {
    if (skipped.length >= slots.skipped) {
      truncated = true;
      return;
    }
    skipped.push(buildSkipped(path, reason));
  };
  // Another entry could not change the answer: both lists are full and one is already cut.
  const isDecided = (): boolean =>
    truncated && skills.length >= slots.skills && skipped.length >= slots.skipped;
  // The budget is spent: the folder the listing stopped at is named, and what follows is not read.
  const skipBudgetSpent = (path: string): void => {
    skip(path, BUDGET_SPENT);
    truncated = true;
  };
  const isFinished = (): boolean => budget.isSpent || isDecided();

  for (const folder of SKILL_FOLDERS) {
    if (isFinished()) break;
    const folderPath = describePath(folder);
    let folderReal: string;
    let entries: Array<Dirent>;
    try {
      const textProblem = await findLinkProblemOnPath(checkout.path, folder);
      if (textProblem !== undefined) {
        skip(folderPath, `\`${folderPath}\` is a link that ${textProblem}`);
        continue;
      }
      folderReal = await realpath(join(checkout.path, folder));
      if (!isInside(checkout.path, folderReal)) {
        skip(folderPath, `\`${folderPath}\` is a link to a folder outside its checkout`);
        continue;
      }
      if (readFolders.has(folderReal)) continue;
      readFolders.add(folderReal);
      entries = await readdir(folderReal, { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) {
        skip(folderPath, `\`${folderPath}\` cannot be read: ${describeFileError(error)}`);
      }
      continue;
    }
    entries.sort((a, b) => compareNames(a.name, b.name));

    for (const entry of entries) {
      if (isFinished()) break;
      // A plain file is no skill, and nothing is said about it.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = describePath(folder, entry.name);
      if (!spendEntry(budget)) {
        skipBudgetSpent(path);
        break;
      }
      let skillFolder = join(folderReal, entry.name);

      // A link is read as text before it is followed to learn what it leads to.
      let linkProblem: string | undefined;
      if (entry.isSymbolicLink()) {
        linkProblem = await findLinkTargetProblem(skillFolder, checkout.path).catch(
          (error: unknown) => `cannot be read: ${describeFileError(error)}`,
        );
      }

      if (!isSkillName(entry.name)) {
        // Only a folder is worth a reason. A link is followed to learn whether it is one,
        // unless its target is already refused: such a link is no skill and is ignored.
        const isFolder =
          entry.isDirectory() ||
          (linkProblem === undefined &&
            (await stat(skillFolder).then(
              (s) => s.isDirectory(),
              () => false,
            )));
        if (isFolder) {
          skip(
            path,
            `\`${path}\` is not a valid skill name: use lowercase letters and digits in groups joined by single hyphens, at most 64 characters`,
          );
        }
        continue;
      }

      // Refuses the folder, once however many paths lead to it.
      const refusalKey = (): string => `${entry.name}\0${skillFolder}`;
      const refuse = (reason: string): void => {
        refusedFolders.add(refusalKey());
        skip(path, reason);
      };

      if (linkProblem !== undefined) {
        refuse(`\`${path}\` is a link that ${linkProblem}`);
        continue;
      }
      try {
        if (entry.isSymbolicLink()) {
          skillFolder = await realpath(skillFolder);
          if (refusedFolders.has(refusalKey())) continue;
          if (!isInside(checkout.path, skillFolder)) {
            refuse(`\`${path}\` is a link to a folder outside its checkout`);
            continue;
          }
          if (!(await stat(skillFolder)).isDirectory()) {
            refuse(`\`${path}\` is a link to a file, not to a folder`);
            continue;
          }
        }
      } catch (error) {
        skip(path, `\`${path}\` cannot be read: ${describeFileError(error)}`);
        continue;
      }

      // `.claude/skills` is often a link to `.agents/skills`: one skill, listed once.
      if (acceptedFolders.has(skillFolder) || refusedFolders.has(refusalKey())) continue;
      if ("reason" in checkout.prefix) {
        refuse(checkout.prefix.reason);
        continue;
      }
      const owner = pathsByName.get(entry.name);
      if (owner !== undefined) {
        refuse(`\`${owner}\` has the same name`);
        continue;
      }
      if (skills.length >= slots.skills) {
        refuse(`this workspace already offers ${String(MAX_REPOSITORY_SKILLS)} skills`);
        continue;
      }

      let markdown: Awaited<ReturnType<typeof readSkillMarkdown>>;
      try {
        markdown = await readSkillMarkdown(skillFolder, checkout.path);
      } catch (error) {
        refuse(`\`${path}/SKILL.md\` cannot be read: ${describeFileError(error)}`);
        continue;
      }
      const parsed =
        "text" in markdown
          ? parseSkillFrontmatter(markdown.text, entry.name, markdown.cut)
          : markdown;
      if ("problem" in parsed) {
        refuse(`\`${path}\`: ${parsed.problem}`);
        continue;
      }
      let folderProblem: Awaited<ReturnType<typeof findSkillFolderProblem>>;
      try {
        folderProblem = await findSkillFolderProblem(skillFolder, checkout.path, budget);
      } catch (error) {
        refuse(`\`${path}\`: its folder cannot be read: ${describeFileError(error)}`);
        continue;
      }
      if (folderProblem !== undefined) {
        if ("budgetSpent" in folderProblem) {
          skipBudgetSpent(path);
          break;
        }
        refuse(`\`${path}\`: its folder ${folderProblem.refusal}`);
        continue;
      }
      acceptedFolders.add(skillFolder);
      pathsByName.set(entry.name, path);
      skills.push({
        checkoutName: checkout.prefix.name,
        name: entry.name,
        description: parsed.description,
        path,
        absolutePath: skillFolder,
      });
    }
  }
  return { skills: skills.sort((a, b) => compareNames(a.name, b.name)), skipped, truncated };
};

/**
 * Lists the skills of every checkout, up to the limit of each list. Never
 * fails: whatever cannot be read becomes a skipped entry. A checkout is read
 * even when both lists are full, because it may have nothing to add. Reading
 * stops once an entry is left out of a full list, and when `budget` is spent.
 * Throws the abort reason of `budget.signal` when the time is over.
 */
const collectRepositorySkills = async (
  checkouts: ReadonlyArray<CheckoutToList>,
  budget: ListingBudget,
): Promise<RepositorySkillListing> => {
  const skills: Array<ListedRepositorySkill> = [];
  const skipped: Array<SkippedRepositorySkill> = [];
  let truncated = false;
  const takenCheckoutNames = new Set<string>();

  for (const checkout of checkouts) {
    if (budget.isSpent) break;
    if (
      truncated &&
      skills.length >= MAX_REPOSITORY_SKILLS &&
      skipped.length >= MAX_REPOSITORY_SKILLS
    ) {
      break;
    }
    // The name is taken even when the checkout cannot be read, so the skills
    // of a later checkout do not take it and change what this one offers
    // once it can be read.
    const checkoutName = formatCheckoutName(checkout.subdirectory, checkout.remote);
    let prefix: CheckoutToRead["prefix"];
    if (checkoutName === undefined) {
      prefix = { reason: "no skill prefix can be made from the name of this checkout" };
    } else if (takenCheckoutNames.has(checkoutName)) {
      prefix = { reason: describeDuplicateCheckoutName(checkoutName) };
    } else {
      takenCheckoutNames.add(checkoutName);
      prefix = { name: checkoutName };
    }

    const where = checkout.subdirectory ?? ".";
    let path: string | undefined;
    let unavailable: string | undefined;
    if (checkout.path === null) {
      unavailable = describeNoMainWorkspace(checkout.remote);
    } else {
      try {
        path = await realpath(checkout.path);
      } catch (error) {
        unavailable = `the checkout folder cannot be read: ${describeFileError(error)}`;
      }
    }
    if (path === undefined) {
      if (skipped.length < MAX_REPOSITORY_SKILLS) {
        skipped.push(buildSkipped(where, unavailable ?? describeNoMainWorkspace(checkout.remote)));
      } else {
        truncated = true;
      }
      continue;
    }

    const listing = await listCheckoutSkills(
      { path, subdirectory: checkout.subdirectory, prefix },
      {
        skills: MAX_REPOSITORY_SKILLS - skills.length,
        skipped: MAX_REPOSITORY_SKILLS - skipped.length,
      },
      budget,
    );
    skills.push(...listing.skills);
    skipped.push(...listing.skipped);
    truncated ||= listing.truncated;
  }
  return { skills, skipped, truncated };
};

/**
 * Lists the repository skills of a workspace, for each checkout in the order
 * given.
 *
 * A skill is a folder `.agents/skills/<name>` or `.claude/skills/<name>`
 * that holds a `SKILL.md` whose frontmatter has a description. The folder name
 * is the skill's name. These folders are skipped, each with a reason:
 *
 * - a folder with an invalid name, without `SKILL.md`, or without a valid description;
 * - a folder whose `SKILL.md` has a frontmatter `name` that is not text or differs from the folder name;
 * - a folder that cannot be read;
 * - a skills folder, a skill folder or a `SKILL.md` that is a link to a place outside its checkout, or a link whose target is an absolute path, or a `SKILL.md` that is not a regular file;
 * - a skill folder that holds such a link, a second `SKILL.md`, or more than the bounds of `findSkillFolderProblem` allow;
 * - a `.claude/skills` folder whose name an `.agents/skills` folder in the same checkout already has;
 * - every folder of a checkout whose skill prefix (`formatCheckoutName`) is empty or the same as an earlier checkout's;
 * - every folder past `MAX_REPOSITORY_SKILLS` skills.
 *
 * A checkout without a folder (`path` is null), or whose folder cannot be
 * read, is one skipped entry named by its subdirectory (`.` for the workspace
 * root). It still takes its skill prefix, so the prefixes of the other
 * checkouts do not depend on whether this one can be read.
 *
 * A folder reached twice, such as through a `.claude/skills` link to
 * `.agents/skills`, is listed or skipped once. A plain file in a skills
 * folder, and a link to a file whose name is not a valid skill name, are
 * ignored, and so is a link that has a name that is not a skill name and a
 * target that is refused. A skills folder that does not exist is no problem.
 * Skipped entries past `MAX_REPOSITORY_SKILLS` are left out and `truncated` is
 * true, and so is every reason's text past `MAX_SKIPPED_REASON_LENGTH`
 * characters.
 *
 * The listing looks at `MAX_LISTING_ENTRIES` files and folders in all, the
 * folders of the skills folders and the contents of every skill folder
 * together. The folder where that runs out is skipped with a reason, the rest
 * is not read, and `truncated` is true. The listing also stops as soon as
 * both lists are full and an entry did not fit, because nothing after it can
 * change the answer. The effect can be interrupted: the listing then stops at
 * the next file or folder it looks at.
 *
 * The `path` of a skill and of a skipped folder is relative to the workspace
 * root (`web/.agents/skills/release`, or `.agents/skills/release` for a
 * checkout at the root), and a reason names that path too. A reason has no
 * control characters and quotes at most 64 characters of a name.
 *
 * Never fails.
 */
export const listRepositorySkills = (
  checkouts: ReadonlyArray<CheckoutToList>,
): Effect.Effect<RepositorySkillListing> =>
  Effect.promise((signal) => collectRepositorySkills(checkouts, buildListingBudget(signal)));

/**
 * Lists the repository skills of a workspace that exists on this runner, from
 * the place of each of its checkouts (see `listRepositorySkills`). Fails with
 * a message only when the workspace folder cannot be read. The message does
 * not contain the folder's absolute path.
 *
 * A checkout's subdirectory is its folder relative to the real workspace
 * root, so a workspace folder reached through a link names the same skills.
 */
export const listWorkspaceRepositorySkills = (
  workspace: WorkspaceToList,
): Effect.Effect<RepositorySkillListing, string> =>
  Effect.tryPromise({
    try: async () => {
      const root = await realpath(workspace.root);
      return Promise.all(
        workspace.checkouts.map(async ({ remote, path }): Promise<CheckoutToList> => {
          // A folder that cannot be resolved is reported by the listing itself.
          const subdirectory = await realpath(path).then(
            (real) => relative(root, real),
            () => relative(workspace.root, path),
          );
          return { remote, subdirectory: subdirectory === "" ? null : subdirectory, path };
        }),
      );
    },
    catch: (error) => `the workspace folder cannot be read: ${describeFileError(error)}`,
  }).pipe(Effect.flatMap(listRepositorySkills));
