/** Compares Skill Sources, which an import and an update check both do. */
import type { SkillSource } from "@hercule/contract";

/** Returns whether two Skill Sources name the same place. */
export const isSameSource = (left: SkillSource, right: SkillSource): boolean => {
  if (left.kind === "upload" || right.kind === "upload") return left.kind === right.kind;
  return left.repo === right.repo && left.path === right.path && left.branch === right.branch;
};
