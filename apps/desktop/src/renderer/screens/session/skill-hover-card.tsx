/**
 * The card that shows a skill's description and where it comes from, opened
 * over a chip on hover.
 */
import { useEffect, useId, useRef, type JSX } from "react";
import type { SessionSkill } from "@hercule/contract";
import "../thread/menus.css";
import { splitSkillName } from "./skill-chip-markup";
import { SkillSourceBadge } from "./skill-source-badge";
import "./skill-hover-card.css";

/**
 * Renders the card for `skill`, anchored to the chip element `anchor`: the
 * skill's name with its source badge, its description, and for a repository
 * skill the folder it lives in.
 *
 * The caller decides when the card shows, by rendering it or not: the editor
 * renders it for the chip it found under the pointer, and a message for the
 * chip it drew. A caller with no skill to show, such as a chip whose skill
 * was deleted since, renders nothing.
 *
 * While it is mounted, the card sets a CSS anchor name on `anchor` (through
 * the CSSOM, which the Content-Security-Policy allows) and removes it when it
 * unmounts. The card is a manual popover in the top layer, so no scrolling
 * field clips it. Its parts are `<span>`s, because the card may be rendered
 * next to a chip inside a message's `<p>`, which holds only phrasing
 * content; the stylesheet gives them their block layout.
 */
export function SkillHoverCard({
  skill,
  anchor,
}: {
  readonly skill: SessionSkill;
  readonly anchor: HTMLElement;
}): JSX.Element {
  const card = useRef<HTMLSpanElement>(null);
  // The id `useId` returns holds characters a CSS ident may not, so they are stripped.
  const anchorName = `--skill-hover-${useId().replace(/\W/g, "")}`;
  useEffect(() => {
    anchor.style.setProperty("anchor-name", anchorName);
    card.current?.showPopover();
    return () => {
      anchor.style.removeProperty("anchor-name");
    };
  }, [anchor, anchorName]);
  const { checkout, skill: skillPart } = splitSkillName(skill.name);
  return (
    <span
      ref={card}
      className="pop skill-hover-card"
      popover="manual"
      role="tooltip"
      style={{ positionAnchor: anchorName }}
    >
      <span className="skill-hover-head">
        <b className="skill-hover-name">
          {checkout === "" ? null : <span className="skill-label-checkout">{checkout}</span>}
          {skillPart}
        </b>
        <SkillSourceBadge source={skill.source} />
      </span>
      {skill.description === "" ? null : (
        <span className="skill-hover-description">{skill.description}</span>
      )}
      {skill.source === "repository" ? (
        <code className="skill-hover-path">{skill.path}</code>
      ) : null}
    </span>
  );
}
