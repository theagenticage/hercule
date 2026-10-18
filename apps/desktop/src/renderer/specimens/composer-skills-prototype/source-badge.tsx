/**
 * PROTOTYPE (#766). The badge that says where a skill comes from, drawn in
 * the `$` and `/` lists and in the chip's hover card.
 */
import type { JSX } from "react";

/** The word the badge shows for each source of a skill. */
const SOURCE_LABELS = { library: "Library", repository: "Repository" } as const;

/**
 * Renders the badge for a skill's source: `Library` for a Skill Library
 * skill, `Repository` for one the checkout holds. It is the book's `.chip`,
 * the same pill Settings > Skills draws its badges with.
 */
export function SourceBadge({
  source,
}: {
  readonly source: "library" | "repository";
}): JSX.Element {
  return <span className="chip source-badge">{SOURCE_LABELS[source]}</span>;
}
