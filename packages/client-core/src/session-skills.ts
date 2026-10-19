/**
 * What the composer's skill lists do with a session's skills: narrow them to
 * what the user typed after the `$` or `/`.
 */
import type { SessionSkill } from "@hercule/contract";

/**
 * Returns the skills that match `query`, in the order the composer's lists
 * show them: first the skills whose name contains the query, then the skills
 * whose description contains it and whose name does not. Each group keeps the
 * order of `skills`, which is the order `session.querySkills` returns:
 * library skills first, then repository skills, each sorted by name.
 *
 * `query` is what the user typed after the `$` or `/`. The match ignores case
 * and looks for the query anywhere in the text, and surrounding whitespace in
 * the query is ignored. A repository skill's name is `<checkout>:<skill>`, so
 * `rel` finds `webshop:release` and `webshop` finds every skill of that
 * checkout. An empty query returns all of `skills`.
 */
export const filterSessionSkills = (
  skills: ReadonlyArray<SessionSkill>,
  query: string,
): ReadonlyArray<SessionSkill> => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return skills;
  const nameMatches: SessionSkill[] = [];
  const descriptionMatches: SessionSkill[] = [];
  for (const skill of skills) {
    if (skill.name.toLowerCase().includes(needle)) nameMatches.push(skill);
    else if (skill.description.toLowerCase().includes(needle)) descriptionMatches.push(skill);
  }
  return [...nameMatches, ...descriptionMatches];
};
