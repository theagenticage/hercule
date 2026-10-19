/**
 * Stages the repository skills of a workspace for the harnesses, inside a
 * start's session skills folder (spec 06 section 9.3).
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { describeError } from "../report";
import type { ListedRepositorySkill } from "./repository";

/**
 * Writes one Claude plugin folder per checkout that has repository skills,
 * inside `sessionSkillsFolder`, and returns the absolute paths of those
 * folders in the order the checkouts appear in `skills`. Writes nothing and
 * returns an empty list when `skills` is empty.
 *
 * Each plugin folder is `<sessionSkillsFolder>/repositories/<checkoutName>/`:
 *
 * - `.claude-plugin/plugin.json` names the plugin `repo-<checkoutName>`;
 * - `skills/<name>` is a symlink to the skill's folder in the checkout.
 *
 * Claude loads each folder as a plugin. Codex and pi load its `skills`
 * folder. The `repo-` prefix keeps the plugin name apart from the `hercule`
 * and `skills` plugins the runner adds, for every checkout name: a repository
 * can be called `hercule` or `skills`.
 *
 * The skills are symlinks, not copies. A skill belongs to its checkout, so an
 * edit to it through the staged folder is the project's own edit.
 *
 * Each link points at the skill's `absolutePath`, the folder the listing
 * checked, so a link in the checkout cannot be swapped for another between
 * the check and the use.
 *
 * Fails with the reason when a folder, file or link cannot be written. The
 * reason is not a sentence: the caller adds the sentence that tells the user
 * what failed. The caller owns `sessionSkillsFolder` and removes it whether
 * this succeeds or fails.
 */
export const stageRepositorySkills = (
  sessionSkillsFolder: string,
  skills: ReadonlyArray<ListedRepositorySkill>,
): Effect.Effect<ReadonlyArray<string>, string> =>
  Effect.tryPromise({
    try: async () => {
      const skillsByCheckout = new Map<string, Array<ListedRepositorySkill>>();
      for (const skill of skills) {
        const group = skillsByCheckout.get(skill.checkoutName) ?? [];
        group.push(skill);
        skillsByCheckout.set(skill.checkoutName, group);
      }
      const pluginFolders: Array<string> = [];
      for (const [checkoutName, checkoutSkills] of skillsByCheckout) {
        const pluginFolder = join(sessionSkillsFolder, "repositories", checkoutName);
        await mkdir(join(pluginFolder, ".claude-plugin"), { recursive: true });
        await writeFile(
          join(pluginFolder, ".claude-plugin", "plugin.json"),
          `${JSON.stringify({ name: `repo-${checkoutName}` })}\n`,
        );
        await mkdir(join(pluginFolder, "skills"), { recursive: true });
        for (const skill of checkoutSkills) {
          await symlink(skill.absolutePath, join(pluginFolder, "skills", skill.name), "dir");
        }
        pluginFolders.push(pluginFolder);
      }
      return pluginFolders;
    },
    catch: describeError,
  });
