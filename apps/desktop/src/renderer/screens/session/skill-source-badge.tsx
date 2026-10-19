import type { JSX } from "react";
import type { SessionSkill } from "@hercule/contract";

/** The word the badge shows for each source of a skill. */
const SOURCE_LABELS = { library: "Library", repository: "Repository" } as const;

/**
 * Renders the badge for where a skill comes from: `Library` for a Skill
 * Library skill, `Repository` for one a checkout holds. It is the book's
 * `.chip`, the pill Settings > Skills draws its badges with.
 */
export function SkillSourceBadge({
  source,
}: {
  readonly source: SessionSkill["source"];
}): JSX.Element {
  return <span className="chip">{SOURCE_LABELS[source]}</span>;
}
