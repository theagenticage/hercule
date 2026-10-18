/**
 * PROTOTYPE (#766). The skill chip, drawn in the composer, in a sent message
 * and in a queued input, and the card that opens over it on hover.
 */
import { useEffect, useId, useRef, useState, type JSX } from "react";
import { SkillIcon } from "../../icons/skill";
import type { Skill } from "./fixture";
import { SourceBadge } from "./source-badge";
import "./skill-chip.css";

/** Where a chip is drawn. */
type ChipPlacement = "composer" | "message";

/**
 * Renders a skill's name as the chip and the card show it: just the name for
 * a Skill Library skill, and for a repository skill the name after its
 * checkout's folder, `webshop:review`, with the folder drawn quieter.
 */
function SkillLabel({ skill }: { readonly skill: Skill }): JSX.Element {
  return (
    <>
      {skill.source === "repository" ? (
        <span className="skill-label-checkout">{skill.checkout}:</span>
      ) : null}
      {skill.name}
    </>
  );
}

/**
 * Renders `skill` as a chip. `selected` draws it as the selected atom of the
 * composer. `hovered` opens its `SkillHoverCard` as if the pointer were on
 * it, and the real pointer opens it too.
 *
 * The chip is an inline element, not an inline box, so its fill and padding
 * grow past the text's line without ever making the line taller.
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
  const [pointerOver, setPointerOver] = useState(false);
  const open = hovered || pointerOver;
  // The id `useId` returns contains characters a CSS ident may not, so they
  // are stripped before it names the anchor.
  const anchor = `--skill-chip-${useId().replace(/\W/g, "")}`;
  return (
    <>
      <span
        className="skill-chip"
        data-placement={placement}
        data-source={skill.source}
        data-selected={selected || undefined}
        style={open ? { anchorName: anchor } : undefined}
        onPointerEnter={() => setPointerOver(true)}
        onPointerLeave={() => setPointerOver(false)}
      >
        <SkillIcon />
        <SkillLabel skill={skill} />
      </span>
      {open ? <SkillHoverCard skill={skill} anchor={anchor} /> : null}
    </>
  );
}

/**
 * Renders the card that shows a skill's description and where it comes from.
 * `anchor` is the CSS anchor name of the chip it opens over. The card is a
 * manual popover, so it sits in the top layer and the composer's scrolling
 * field cannot clip it. It is made of `<span>`s, because it is rendered next
 * to the chip, and the chip may sit in a message's `<p>`, which can hold
 * only phrasing content. The stylesheet gives the spans their block layout.
 */
function SkillHoverCard({
  skill,
  anchor,
}: {
  readonly skill: Skill;
  readonly anchor: string;
}): JSX.Element {
  const card = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    card.current?.showPopover();
  }, []);
  return (
    <span
      ref={card}
      className="pop skill-hover-card"
      popover="manual"
      role="tooltip"
      style={{ positionAnchor: anchor }}
    >
      <span className="skill-hover-head">
        <b className="skill-hover-name">
          <SkillLabel skill={skill} />
        </b>
        <SourceBadge source={skill.source} />
      </span>
      <span className="skill-hover-description">{skill.description}</span>
      {skill.source === "repository" ? (
        <code className="skill-hover-path">{`${skill.checkout}/.claude/skills/${skill.name}`}</code>
      ) : null}
    </span>
  );
}
