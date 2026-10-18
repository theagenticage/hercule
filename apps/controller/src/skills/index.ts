/**
 * The Skill Library: the user's skills, kept by the controller as Skills and
 * their Skill Revisions, with each revision's files in the Data Root (spec 02
 * Skill, spec 04 "Skill rows", spec 11 §2 `skill`).
 */
export {
  SkillFileError,
  SkillPathsCollide,
  buildSkillRevisionFolder,
  buildSkillsFolder,
  listRevisionFiles,
  readRevisionFiles,
  sweepSkillFolders,
  writeFolderFiles,
} from "./files";
export { listSkillPathIssues } from "./content";
export { SkillService, SkillServiceLayer } from "./service";
