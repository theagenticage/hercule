/**
 * Stages the skills of an Antigravity session (spec 06 section 9.4): the
 * library skills of the start and the skills of the workspace's checkouts,
 * in the one place `agy` reads skills from for a single session.
 */
import { mkdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import * as Effect from "effect/Effect";
import type { AdapterFailed } from "@hercule/protocol";
import { describeFolderFailure } from "../../skills";
import { buildAdapterFailed } from "../adapter-error-builders";
import type { HarnessRunnerContext } from "../index";
import { describeFileFailure, readFolderNames } from "../session-files";

/** The parts of the runner context that say which skills a session has. */
export type SkillsContext = Pick<
  HarnessRunnerContext,
  "sessionSkillsFolder" | "librarySkillsFolder" | "repositorySkillsFolders"
>;

/**
 * Links every skill of the session into `<sessionSkillsFolder>/.agents/skills`
 * and returns the folders to pass to `agy` as additional directories: the
 * session skills folder when the session has any skill, none otherwise. When
 * none is returned, nothing was written.
 *
 * Each skill is one relative symbolic link, named after the skill, to its
 * folder in the library skills folder or in a repository skills folder (which
 * itself links into the checkout). The library skills come first, then the
 * repository skills folders in order. When two skills have the same name, the
 * first one is linked and the others are skipped, because `agy` lists one
 * skill per name and drops the rest without a message. A skipped skill is
 * still reached by the pointer line of a Skill Reference.
 *
 * The folder is passed as an additional directory of the session and is not
 * written into the Harness Home. Every place in the Harness Home is shared by
 * every session of the account and re-read live, so a skill put there would
 * show up in sessions it was not meant for. An additional directory belongs to
 * one session. The runner removes the session skills folder when the session
 * exits.
 *
 * Fails with `AdapterFailed`, whose message gives the operating system's
 * reason and no path, when the links cannot be written. This includes a
 * `.agents` folder that already exists: every start and resume gets a fresh
 * session skills folder, so there is nothing to merge with.
 */
export const stageAgySkills = (
  ctx: SkillsContext,
): Effect.Effect<ReadonlyArray<string>, AdapterFailed> => {
  const { sessionSkillsFolder } = ctx;
  if (sessionSkillsFolder === undefined) return Effect.succeed([]);
  const linkFolder = join(sessionSkillsFolder, ".agents", "skills");
  const skillsFolders = [ctx.librarySkillsFolder, ...(ctx.repositorySkillsFolders ?? [])].flatMap(
    (folder) => (folder === undefined ? [] : [join(folder, "skills")]),
  );
  return Effect.tryPromise({
    try: async () => {
      const linked = new Set<string>();
      const links: Array<{ readonly name: string; readonly target: string }> = [];
      for (const skillsFolder of skillsFolders) {
        for (const name of await readFolderNames(skillsFolder)) {
          if (linked.has(name)) continue;
          linked.add(name);
          links.push({ name, target: relative(linkFolder, join(skillsFolder, name)) });
        }
      }
      if (links.length === 0) return [];
      // Not recursive, so an existing `.agents` fails the start instead of
      // being merged into.
      await mkdir(join(sessionSkillsFolder, ".agents"));
      await mkdir(linkFolder);
      for (const { name, target } of links) await symlink(target, join(linkFolder, name), "dir");
      return [sessionSkillsFolder];
    },
    catch: (error) => buildAdapterFailed(describeFolderFailure(describeFileFailure(error))),
  });
};
