/**
 * PROTOTYPE (#766). The skill chip, drawn in the composer, in a sent message
 * and in a queued input, and the card that opens over it on hover. A stub:
 * the drawing replaces it.
 */
import type { JSX } from "react";
import { buildSkillToken, type Skill } from "./fixture";
import "./skill-chip.css";

/** Where a chip is drawn. */
export type ChipPlacement = "composer" | "message";

/**
 * Renders `skill` as a chip. `selected` draws it as the selected atom of the
 * composer. `hovered` opens its `SkillHoverCard`, as when the pointer is on it.
 */
export function SkillChip({
  skill,
  placement,
  selected = false,
  hovered = false,
}: {
  readonly skill: Skill;
  readonly placement: ChipPlacement;
  readonly selected?: boolean;
  readonly hovered?: boolean;
}): JSX.Element {
  return (
    <span
      className="skill-chip"
      data-placement={placement}
      data-source={skill.source}
      data-selected={selected || undefined}
    >
      {`[${buildSkillToken(skill)}]`}
      {hovered ? <SkillHoverCard skill={skill} /> : null}
    </span>
  );
}

/** Renders the card that shows a skill's description and where it comes from. */
export function SkillHoverCard({ skill }: { readonly skill: Skill }): JSX.Element {
  return (
    <span className="skill-hover-card" role="tooltip">
      {` (card: ${skill.source}, ${skill.description})`}
    </span>
  );
}
