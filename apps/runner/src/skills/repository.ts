/**
 * Lists the repository skills of a workspace: the skill folders in the
 * `.agents/skills` and `.claude/skills` folders of each checkout (spec 06
 * section 9.4).
 *
 * The runner reads the folders live from the checkouts. It copies nothing and
 * keeps no state, so a skill the user adds to a checkout shows up in the next
 * listing.
 */
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  MAX_REPOSITORY_SKILLS,
  MAX_SKILL_DESCRIPTION_LENGTH,
  SkillName,
  formatCheckoutName,
  type RepositorySkill,
  type RepositorySkillFolder,
  type SkippedRepositorySkill,
} from "@hercule/protocol";
import type { RegisteredCheckout } from "../workspaces/registry";

/** The folders of a checkout that hold repository skills, in the order they win a name. */
const SKILL_FOLDERS: ReadonlyArray<RepositorySkillFolder> = [".agents/skills", ".claude/skills"];

/**
 * How much of a `SKILL.md` is read. The frontmatter is at the top of the
 * file, and a repository can hold a file of any size.
 */
const MAX_FRONTMATTER_BYTES = 64 * 1024;

/** The parts of a workspace that the listing reads: its directory and the place of each checkout. */
export interface WorkspaceToList {
  readonly root: string;
  readonly checkouts: ReadonlyArray<Pick<RegisteredCheckout, "checkoutId" | "remote" | "path">>;
}

/** A repository skill with the absolute path of its folder, which only the runner uses. */
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

/** Returns the message of an error, or the value itself as text. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Returns true when `error` is a Node error for a missing file or a path through a file. */
const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Returns the first `MAX_FRONTMATTER_BYTES` bytes of a file as text, or undefined when it does not exist. */
const readFileStart = async (path: string): Promise<string | undefined> => {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES);
    const { bytesRead } = await file.read(buffer, 0, MAX_FRONTMATTER_BYTES, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
};

/**
 * Reads the frontmatter of a `SKILL.md`: the text between the first two lines
 * that hold only `---`. Returns the description, or the reason this file
 * offers none.
 *
 * The reason is also a mismatch between the frontmatter `name` and
 * `folderName`. The harnesses name a skill by its frontmatter `name` and fall
 * back to the folder name, and the Agent Skills format requires the two to be
 * equal, so a skill with different ones would have a name here that the
 * harnesses do not use. A frontmatter without a `name` is accepted.
 */
const readSkillFile = (
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
        problem: `its frontmatter name \`${declaredName.trim()}\` differs from its folder name \`${folderName}\`; the Agent Skills format requires them to match`,
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
 * Collects the skills and skipped folders of a workspace, up to the limit of
 * each. It never fails: whatever cannot be read becomes a skipped folder.
 */
const collectRepositorySkills = async (
  workspace: WorkspaceToList,
): Promise<RepositorySkillListing> => {
  const skills: Array<ListedRepositorySkill> = [];
  const skipped: Array<SkippedRepositorySkill> = [];
  const takenCheckoutNames = new Set<string>();

  for (const checkout of workspace.checkouts) {
    const subdirectory = relative(workspace.root, checkout.path) || null;
    const checkoutName = formatCheckoutName(subdirectory, checkout.remote);
    // A skipped skill is named by its path from the workspace root, which
    // tells the checkout apart. A listed skill's path is relative to its checkout.
    const locate = (path: string): string =>
      subdirectory === null ? path : `${subdirectory}/${path}`;
    const skip = (path: string, reason: string): void => {
      if (skipped.length < MAX_REPOSITORY_SKILLS) skipped.push({ path: locate(path), reason });
    };

    // The prefix of this checkout's skills, or undefined with the reason it has none.
    let prefix: string | undefined;
    let noPrefixReason = "";
    if (checkoutName === undefined) {
      noPrefixReason = "no skill prefix can be made from the name of this checkout";
    } else if (takenCheckoutNames.has(checkoutName)) {
      noPrefixReason = `checkout \`${checkoutName}\` has the same skill prefix as another checkout in this workspace`;
    } else {
      takenCheckoutNames.add(checkoutName);
      prefix = checkoutName;
    }
    const firstSkillOfCheckout = skills.length;

    const names = new Map<string, string>();
    const seenFolders = new Set<string>();
    for (const folder of SKILL_FOLDERS) {
      let entries: Array<string>;
      try {
        entries = (await readdir(join(checkout.path, folder))).sort();
      } catch (error) {
        if (!isMissing(error))
          skip(folder, `\`${locate(folder)}\` cannot be read: ${describeError(error)}`);
        continue;
      }
      for (const name of entries) {
        const path = `${folder}/${name}`;
        const absolutePath = join(checkout.path, folder, name);
        let identity: string;
        try {
          if (!(await stat(absolutePath)).isDirectory()) continue;
          identity = await realpath(absolutePath);
        } catch (error) {
          skip(path, `\`${locate(path)}\` cannot be read: ${describeError(error)}`);
          continue;
        }
        // `.claude/skills` is often a link to `.agents/skills`: one skill, listed once.
        if (seenFolders.has(identity)) continue;
        seenFolders.add(identity);

        if (prefix === undefined) {
          skip(path, noPrefixReason);
        } else if (!isSkillName(name)) {
          skip(
            path,
            `\`${locate(path)}\` is not a valid skill name: use lowercase letters and digits in groups joined by single hyphens, at most 64 characters`,
          );
        } else if (names.has(name)) {
          skip(path, `\`${names.get(name)}\` has the same name`);
        } else if (skills.length >= MAX_REPOSITORY_SKILLS) {
          skip(path, `this workspace already offers ${String(MAX_REPOSITORY_SKILLS)} skills`);
        } else {
          let text: string | undefined;
          try {
            text = await readFileStart(join(absolutePath, "SKILL.md"));
          } catch (error) {
            skip(path, `\`${locate(path)}/SKILL.md\` cannot be read: ${describeError(error)}`);
            continue;
          }
          if (text === undefined) {
            skip(path, `\`${locate(path)}\` has no SKILL.md`);
            continue;
          }
          const read = readSkillFile(text, name);
          if ("problem" in read) {
            skip(path, `\`${locate(path)}\`: ${read.problem}`);
            continue;
          }
          names.set(name, locate(path));
          skills.push({
            checkoutId: checkout.checkoutId,
            checkoutName: prefix,
            name,
            description: read.description,
            path,
            absolutePath,
          });
        }
      }
    }
    // Both folders are read before the checkout's skills are put in name order.
    skills.push(
      ...skills.splice(firstSkillOfCheckout).sort((a, b) => compareNames(a.name, b.name)),
    );
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
 * - a `.claude/skills` folder whose name an `.agents/skills` folder in the same checkout already has;
 * - every folder of a checkout whose skill prefix (`formatCheckoutName`) is empty or the same as an earlier checkout's;
 * - every folder past `MAX_REPOSITORY_SKILLS` skills.
 *
 * A folder reached twice, such as through a `.claude/skills` link to
 * `.agents/skills`, is listed once. A folder that does not exist is no problem.
 * Entries past `MAX_REPOSITORY_SKILLS` in `skipped` are left out.
 *
 * A checkout's subdirectory is its path relative to the workspace root; a
 * checkout at the root has none. The `path` of a skill is relative to its
 * checkout. The `path` of a skipped folder is relative to the workspace root
 * (`web/.agents/skills/My_Skill`), and its reason names that path too. Fails with a message only when the workspace
 * root cannot be read.
 */
export const listRepositorySkills = (
  workspace: WorkspaceToList,
): Effect.Effect<RepositorySkillListing, string> =>
  Effect.tryPromise({
    try: () => stat(workspace.root),
    catch: (error) => `the workspace directory cannot be read: ${describeError(error)}`,
  }).pipe(Effect.andThen(Effect.promise(() => collectRepositorySkills(workspace))));
