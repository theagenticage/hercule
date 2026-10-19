/**
 * Lists the repository skills of a workspace: the skill folders in the
 * `.agents/skills` and `.claude/skills` folders of each checkout (spec 06
 * section 9.4).
 *
 * The runner reads the folders live from the checkouts. It copies nothing and
 * keeps no state, so a skill the user adds to a checkout shows up in the next
 * listing.
 *
 * A checkout is untrusted input: a repository can commit a symbolic link to
 * any place on the runner's disk, such as the user's own `~/.claude/skills`.
 * Links inside the checkout are fine and common (`.claude/skills` pointing at
 * `.agents/skills`). A skills folder, a skill folder or a `SKILL.md` that
 * resolves outside the checkout is skipped.
 */
import { constants, type Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  MAX_FACT_LENGTH,
  MAX_REPOSITORY_SKILLS,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKIPPED_REASON_LENGTH,
  SkillName,
  describeDuplicateCheckoutName,
  formatCheckoutName,
  type RepositorySkill,
  type RepositorySkillFolder,
  type SkippedRepositorySkill,
} from "@hercule/protocol";
import { describeError } from "../report";
import type { RegisteredCheckout } from "../workspaces/registry";

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

/** The parts of a workspace that the listing reads: its directory and the place of each checkout. */
export interface WorkspaceToList {
  readonly root: string;
  readonly checkouts: ReadonlyArray<Pick<RegisteredCheckout, "remote" | "path">>;
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
 * the folders that cannot be offered, in the order the listing found them.
 * Each list holds at most `MAX_REPOSITORY_SKILLS` entries.
 */
export interface RepositorySkillListing {
  readonly skills: ReadonlyArray<ListedRepositorySkill>;
  readonly skipped: ReadonlyArray<SkippedRepositorySkill>;
}

const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isSkillName = Schema.is(SkillName);

/** Returns true when `error` is a Node error for a missing file or a path through a file. */
const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/**
 * Returns the message of a file system error without the absolute path Node
 * puts at its end (`ENOENT: no such file or directory, open '/home/me/x'`).
 * The message reaches clients, and a runner's paths stay on the runner.
 */
const describeFileError = (error: unknown): string =>
  describeError(error).replace(/, \w+ '.*'$/s, "");

/** Returns `text` cut to `MAX_QUOTED_LENGTH` characters, ending in `...` when it was cut. */
const shorten = (text: string): string => {
  const characters = Array.from(text);
  return characters.length <= MAX_QUOTED_LENGTH
    ? text
    : `${characters.slice(0, MAX_QUOTED_LENGTH).join("")}...`;
};

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

/** Returns `text` cut to `limit` characters, ending in `...` when it was cut. */
const cut = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;

/** Returns true when `path` is `folder` or lies below it. Both paths are absolute and have no links. */
const isInside = (folder: string, path: string): boolean => {
  const fromFolder = relative(folder, path);
  return fromFolder !== ".." && !fromFolder.startsWith(`..${sep}`) && !isAbsolute(fromFolder);
};

/**
 * Parses the frontmatter of a `SKILL.md`: the text between the first two lines
 * that hold only `---`. Returns the description, or the reason this file
 * offers none.
 *
 * The reason is also a mismatch between the frontmatter `name` and
 * `folderName`. The harnesses name a skill by its frontmatter `name` and fall
 * back to the folder name, and the Agent Skills format requires the two to be
 * equal, so a skill with different ones would have a name here that the
 * harnesses do not use. A frontmatter without a `name` is accepted.
 *
 * The reason quotes at most `MAX_QUOTED_LENGTH` characters of any name.
 */
export const parseSkillFrontmatter = (
  text: string,
  folderName: string,
): { description: string } | { problem: string } => {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (lines[0]?.trimEnd() !== "---" || end === -1) {
    return { problem: "its SKILL.md has no frontmatter between two `---` lines" };
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
  const declaredName = "name" in fields ? fields.name : undefined;
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
  return { description: trimmed };
};

/**
 * Reads the start of the `SKILL.md` in `skillFolder`. Returns its text, or the
 * reason the file cannot be used: it is missing, or it is a link to a file
 * outside `checkoutPath`, or it is not a regular file. Throws a file system
 * error when the file cannot be opened or read.
 *
 * The file is opened without waiting, then checked on the open handle. A named
 * pipe called `SKILL.md` would otherwise block the open forever.
 */
const readSkillMarkdown = async (
  skillFolder: string,
  checkoutPath: string,
): Promise<{ text: string } | { problem: string }> => {
  let path: string;
  try {
    path = await realpath(join(skillFolder, "SKILL.md"));
  } catch (error) {
    if (isMissing(error)) return { problem: "its folder has no SKILL.md" };
    throw error;
  }
  if (!isInside(checkoutPath, path)) {
    return { problem: "its SKILL.md is a link to a file outside its checkout" };
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) return { problem: "its SKILL.md is not a regular file" };
    const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES);
    const { bytesRead } = await file.read(buffer, 0, MAX_FRONTMATTER_BYTES, 0);
    return { text: buffer.toString("utf8", 0, bytesRead) };
  } finally {
    await file.close();
  }
};

/** The skills and skipped folders of one checkout. */
interface CheckoutListing {
  readonly skills: ReadonlyArray<ListedRepositorySkill>;
  readonly skipped: ReadonlyArray<SkippedRepositorySkill>;
}

/** What one checkout may still add to the listing of its workspace. */
interface Room {
  readonly skills: number;
  readonly skipped: number;
}

/** One checkout, ready to be read. */
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
 * offer. Adds at most `room.skills` skills and `room.skipped` skipped folders,
 * and stops reading once both are full. Never fails: whatever cannot be read
 * becomes a skipped folder.
 *
 * Each folder name is checked against the skill name rule before the runner
 * touches the folder, so a checkout with thousands of folders costs little.
 */
const listCheckoutSkills = async (
  checkout: CheckoutToRead,
  room: Room,
): Promise<CheckoutListing> => {
  const skills: Array<ListedRepositorySkill> = [];
  const skipped: Array<SkippedRepositorySkill> = [];
  // The skill name of each accepted skill, with its path for the "same name" reason.
  const pathsByName = new Map<string, string>();
  // The folder of each accepted skill, so a folder reached by two paths is listed once.
  const acceptedFolders = new Set<string>();

  // A path from the workspace root. A skipped skill is named by it, and so is a listed one.
  const describePath = (folder: string, name?: string): string =>
    [checkout.subdirectory, folder, name === undefined ? undefined : shorten(name)]
      .filter((part) => part !== undefined && part !== null)
      .join("/");
  const skip = (path: string, reason: string): void => {
    if (skipped.length >= room.skipped) return;
    skipped.push({
      path: cut(escapeControlCharacters(path), MAX_FACT_LENGTH),
      reason: cut(escapeControlCharacters(reason), MAX_SKIPPED_REASON_LENGTH),
    });
  };
  const isFull = (): boolean => skills.length >= room.skills && skipped.length >= room.skipped;

  for (const folder of SKILL_FOLDERS) {
    if (isFull()) break;
    const folderPath = describePath(folder);
    let folderReal: string;
    let entries: Array<Dirent>;
    try {
      folderReal = await realpath(join(checkout.path, folder));
      if (!isInside(checkout.path, folderReal)) {
        skip(folderPath, `\`${folderPath}\` is a link to a folder outside its checkout`);
        continue;
      }
      entries = await readdir(folderReal, { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) {
        skip(folderPath, `\`${folderPath}\` cannot be read: ${describeFileError(error)}`);
      }
      continue;
    }
    entries.sort((a, b) => compareNames(a.name, b.name));

    for (const entry of entries) {
      if (isFull()) break;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = describePath(folder, entry.name);
      let skillFolder = join(folderReal, entry.name);

      if (!isSkillName(entry.name)) {
        // Only a folder is worth a reason. A link is followed to learn whether it is one.
        if (skipped.length >= room.skipped) continue;
        const isFolder =
          entry.isDirectory() ||
          (await stat(skillFolder).then(
            (s) => s.isDirectory(),
            () => false,
          ));
        if (isFolder) {
          skip(
            path,
            `\`${path}\` is not a valid skill name: use lowercase letters and digits in groups joined by single hyphens, at most 64 characters`,
          );
        }
        continue;
      }

      try {
        if (entry.isSymbolicLink()) {
          skillFolder = await realpath(skillFolder);
          if (!isInside(checkout.path, skillFolder)) {
            skip(path, `\`${path}\` is a link to a folder outside its checkout`);
            continue;
          }
          if (!(await stat(skillFolder)).isDirectory()) continue;
        }
      } catch (error) {
        skip(path, `\`${path}\` cannot be read: ${describeFileError(error)}`);
        continue;
      }

      // `.claude/skills` is often a link to `.agents/skills`: one skill, listed once.
      if (acceptedFolders.has(skillFolder)) continue;
      if ("reason" in checkout.prefix) {
        skip(path, checkout.prefix.reason);
        continue;
      }
      const owner = pathsByName.get(entry.name);
      if (owner !== undefined) {
        skip(path, `\`${owner}\` has the same name`);
        continue;
      }
      if (skills.length >= room.skills) {
        skip(path, `this workspace already offers ${String(MAX_REPOSITORY_SKILLS)} skills`);
        continue;
      }

      let markdown: Awaited<ReturnType<typeof readSkillMarkdown>>;
      try {
        markdown = await readSkillMarkdown(skillFolder, checkout.path);
      } catch (error) {
        skip(path, `\`${path}/SKILL.md\` cannot be read: ${describeFileError(error)}`);
        continue;
      }
      const parsed =
        "text" in markdown ? parseSkillFrontmatter(markdown.text, entry.name) : markdown;
      if ("problem" in parsed) {
        skip(path, `\`${path}\`: ${parsed.problem}`);
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
  return { skills: skills.sort((a, b) => compareNames(a.name, b.name)), skipped };
};

/**
 * Lists the skills of every checkout of a workspace, up to the limit of each
 * list. `workspaceRoot` has no links in it. Never fails: whatever cannot be
 * read becomes a skipped folder.
 */
const collectRepositorySkills = async (
  workspaceRoot: string,
  checkouts: WorkspaceToList["checkouts"],
): Promise<RepositorySkillListing> => {
  const skills: Array<ListedRepositorySkill> = [];
  const skipped: Array<SkippedRepositorySkill> = [];
  const takenCheckoutNames = new Set<string>();

  for (const checkout of checkouts) {
    if (skills.length >= MAX_REPOSITORY_SKILLS && skipped.length >= MAX_REPOSITORY_SKILLS) break;
    let path: string;
    try {
      path = await realpath(checkout.path);
    } catch (error) {
      if (!isMissing(error) && skipped.length < MAX_REPOSITORY_SKILLS) {
        skipped.push({
          path: cut(
            escapeControlCharacters(relative(workspaceRoot, checkout.path) || "."),
            MAX_FACT_LENGTH,
          ),
          reason: `the checkout folder cannot be read: ${describeFileError(error)}`,
        });
      }
      continue;
    }
    const subdirectory = relative(workspaceRoot, path) || null;
    const checkoutName = formatCheckoutName(subdirectory, checkout.remote);
    let prefix: CheckoutToRead["prefix"];
    if (checkoutName === undefined) {
      prefix = { reason: "no skill prefix can be made from the name of this checkout" };
    } else if (takenCheckoutNames.has(checkoutName)) {
      prefix = { reason: describeDuplicateCheckoutName(checkoutName) };
    } else {
      takenCheckoutNames.add(checkoutName);
      prefix = { name: checkoutName };
    }
    const listing = await listCheckoutSkills(
      { path, subdirectory, prefix },
      {
        skills: MAX_REPOSITORY_SKILLS - skills.length,
        skipped: MAX_REPOSITORY_SKILLS - skipped.length,
      },
    );
    skills.push(...listing.skills);
    skipped.push(...listing.skipped);
  }
  return { skills, skipped };
};

/**
 * Lists the repository skills of a workspace, for each checkout in the order
 * the workspace lists them.
 *
 * A skill is a folder `.agents/skills/<name>` or `.claude/skills/<name>`
 * that holds a `SKILL.md` whose frontmatter has a description. The folder name
 * is the skill's name. These folders are skipped, each with a reason:
 *
 * - a folder with an invalid name, without `SKILL.md`, or without a valid description;
 * - a folder whose `SKILL.md` has a frontmatter `name` that differs from the folder name;
 * - a folder that cannot be read;
 * - a skills folder, a skill folder or a `SKILL.md` that is a link to a place outside its checkout, or a `SKILL.md` that is not a regular file;
 * - a `.claude/skills` folder whose name an `.agents/skills` folder in the same checkout already has;
 * - every folder of a checkout whose skill prefix (`formatCheckoutName`) is empty or the same as an earlier checkout's;
 * - every folder past `MAX_REPOSITORY_SKILLS` skills.
 *
 * A folder reached twice, such as through a `.claude/skills` link to
 * `.agents/skills`, is listed once. A folder that does not exist is no problem.
 * Entries past `MAX_REPOSITORY_SKILLS` in `skipped` are left out, and so is
 * every reason's text past `MAX_SKIPPED_REASON_LENGTH` characters.
 *
 * The `path` of a skill and of a skipped folder is relative to the workspace
 * root (`web/.agents/skills/release`, or `.agents/skills/release` for a
 * checkout at the root), and a reason names that path too. A reason has no
 * control characters and quotes at most 64 characters of a name.
 *
 * Fails with a message only when the workspace folder cannot be read. The
 * message does not contain the folder's absolute path.
 */
export const listRepositorySkills = (
  workspace: WorkspaceToList,
): Effect.Effect<RepositorySkillListing, string> =>
  Effect.tryPromise({
    try: () => realpath(workspace.root),
    catch: (error) => `the workspace folder cannot be read: ${describeFileError(error)}`,
  }).pipe(
    Effect.flatMap((root) =>
      Effect.promise(() => collectRepositorySkills(root, workspace.checkouts)),
    ),
  );
