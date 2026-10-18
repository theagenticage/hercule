import {
  buildSkillImportQuery,
  describeSkillTooLarge,
  importSkillArchive,
  type HerculeClient,
  type SkillImportOutcome,
} from "@hercule/client-core";
import type { Bridge } from "../../../../../../ipc/bridge";
import type { PickedSkill } from "../../../../../../ipc/contract";

/**
 * Imports one skill of the folder the user last picked: main builds its tar
 * archive, then `skill.import` sends it with the skill's GitHub source, if it
 * has one, and with `replace` when `replace` is true. Returns what became of
 * the skill. Both the import dialog and Upload new version send a skill this
 * way.
 *
 * An archive main does not build, because it is over `MAX_SKILL_BYTES` or a
 * file cannot be read, is a refusal and is not sent. Rejects, as
 * `importSkillArchive` does, with an error about the connection or the
 * credential, and when main refuses to build at all.
 */
export const importPickedSkill = async (
  bridge: Bridge,
  client: HerculeClient,
  skill: PickedSkill,
  replace: boolean,
): Promise<SkillImportOutcome> => {
  const built = await bridge.skillArchive.build({ name: skill.name });
  if (built._tag === "TooLarge")
    return { kind: "refused", reason: describeSkillTooLarge(skill.name) };
  if (built._tag === "Unreadable") return { kind: "refused", reason: built.reason };
  return importSkillArchive(client, buildSkillImportQuery(skill, replace), built.archive);
};
