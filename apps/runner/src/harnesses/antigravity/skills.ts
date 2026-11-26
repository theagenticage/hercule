/**
 * Stages the skills of an Antigravity session (spec 06 section 9.4): the
 * library skills of the start and the skills of the workspace's checkouts,
 * in the one place `agy` reads skills from for a single session.
 */
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import * as Effect from "effect/Effect";
import type { AdapterFailed } from "@hercule/protocol";
import { describeFolderFailure } from "../../skills";
import { buildAdapterFailed } from "../adapter-error-builders";
import type { HarnessRunnerContext } from "../index";
import { describeFileFailure, readFolderNames } from "../session-files";

/** A skill that `agy` does not list, because an earlier skill has its name. */
export interface ShadowedSkill {
  /** What a message writes to name the skill, without the `$`: `<name>`, or `<checkout>:<name>`. */
  readonly reference: string;
  /** What a message writes to name the skill that has the name, in the same form. */
  readonly heldBy: string;
}

/**
 * Links every skill of the session into `<sessionSkillsFolder>/.agents/skills`
 * and returns the session skills folder with its symbolic links resolved, to
 * pass to `agy` as an additional directory, with the skills it did not link
 * (see below). Returns undefined when the session has no skill, and then
 * nothing was written.
 *
 * The folder is resolved because the pointer line of a Skill Reference names
 * the real path of a `SKILL.md` (`resolveSkillFile`). Where the runner's
 * storage lies behind a link (macOS's `/var`, a `/home` that links elsewhere),
 * `agy` would otherwise see that path as outside the additional directory and
 * ask for approval to read it.
 *
 * Each skill is one relative symbolic link, named after the skill, to its
 * folder in the library skills folder or in a repository skills folder (which
 * itself links into the checkout). The library skills come first, then the
 * repository skills folders in order. When two skills have the same name, the
 * first one is linked and the others are skipped, because `agy` lists one
 * skill per name and drops the rest without a message. The skipped skills are
 * returned as `shadowed`, so the caller can tell the user. A skipped skill is
 * still reached by the pointer line of a Skill Reference. A repository skill
 * is named `<checkout>:<name>`, where the checkout name is the name of its
 * folder under `repositories/` in the session skills folder.
 *
 * The folder is passed as an additional directory of the session and is not
 * written into the Harness Home. Every place in the Harness Home is shared by
 * every session of the account and re-read live, so a skill put there would
 * show up in sessions it was not meant for. An additional directory belongs to
 * one session. The runner removes the session skills folder when the session
 * exits.
 *
 * The folder also gets an empty `.git` file. `agy` walks up from an additional
 * directory to the nearest git root, as it does from the working directory. If
 * the runner's storage lies inside a repository (a dotfiles repository in the
 * user's home, say), that repository's skills, instructions and hooks would
 * reach every session that has skills. The empty file stops the walk at this
 * folder. It is the same boundary the runner puts in a workspace root, but
 * written here with its own error message: the one in `ensureRootBoundary`
 * names the workspace folder.
 *
 * Fails with `AdapterFailed`, whose message gives the operating system's
 * reason and no path, when the links cannot be written. This includes a
 * `.agents` folder that already exists: every start and resume gets a fresh
 * session skills folder, so there is nothing to merge with.
 */
export const stageAgySkills = (
  ctx: Pick<
    HarnessRunnerContext,
    "sessionSkillsFolder" | "librarySkillsFolder" | "repositorySkillsFolders"
  >,
): Effect.Effect<
  { readonly folder: string; readonly shadowed: ReadonlyArray<ShadowedSkill> } | undefined,
  AdapterFailed
> => {
  const { sessionSkillsFolder } = ctx;
  if (sessionSkillsFolder === undefined) return Effect.succeed(undefined);
  const linkFolder = join(sessionSkillsFolder, ".agents", "skills");
  const skillsFolders = [
    ...(ctx.librarySkillsFolder === undefined
      ? []
      : [{ folder: join(ctx.librarySkillsFolder, "skills"), checkout: undefined }]),
    ...(ctx.repositorySkillsFolders ?? []).map((folder) => ({
      folder: join(folder, "skills"),
      checkout: basename(folder),
    })),
  ];
  return Effect.tryPromise({
    try: async () => {
      // The reference of the skill that holds each name.
      const holders = new Map<string, string>();
      const shadowed: Array<ShadowedSkill> = [];
      const links: Array<{ readonly name: string; readonly target: string }> = [];
      for (const { folder, checkout } of skillsFolders) {
        for (const name of await readFolderNames(folder)) {
          const reference = checkout === undefined ? name : `${checkout}:${name}`;
          const heldBy = holders.get(name);
          if (heldBy !== undefined) {
            shadowed.push({ reference, heldBy });
            continue;
          }
          holders.set(name, reference);
          links.push({ name, target: relative(linkFolder, join(folder, name)) });
        }
      }
      if (links.length === 0) return undefined;
      // The targets are relative to the folder as it is named here. The folders
      // are made by the runner inside the session skills folder, so the same
      // relative path leads to the skill from the resolved one.
      const root = await realpath(sessionSkillsFolder);
      // Not recursive, so an existing `.agents` fails the start instead of
      // being merged into.
      await mkdir(join(root, ".agents"));
      await mkdir(join(root, ".agents", "skills"));
      // `wx` fails when anything is at the path: the folder is fresh, so nothing should be.
      await writeFile(join(root, ".git"), "", { flag: "wx" });
      for (const { name, target } of links) {
        await symlink(target, join(root, ".agents", "skills", name), "dir");
      }
      return { folder: root, shadowed };
    },
    catch: (error) => buildAdapterFailed(describeFolderFailure(describeFileFailure(error))),
  });
};

/**
 * Builds the warning that tells the user which skills `agy` does not offer to
 * the model by itself, each with the skill that has its name. Such a skill
 * still runs when a message names it.
 */
export const buildShadowedSkillsWarning = (shadowed: ReadonlyArray<ShadowedSkill>): string =>
  `Antigravity lists one skill per name, so it does not offer some skills to the model by itself: ${shadowed
    .map(({ reference, heldBy }) => `$${reference} (same name as $${heldBy})`)
    .join(", ")}. Name a skill in a message to run it.`;
