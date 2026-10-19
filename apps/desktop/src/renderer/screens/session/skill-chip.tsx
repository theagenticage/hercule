/**
 * The skill chip as React draws it, in a sent message and in a queued
 * input, and the chip that opens its hover card. The composer's editor draws
 * the same chip as plain DOM from the same markup (skill-chip-markup.ts).
 */
import { createElement, useState, type JSX, type PointerEventHandler, type ReactNode } from "react";
import type { SessionSkill } from "@hercule/contract";
import { SkillHoverCard } from "./skill-hover-card";
import {
  buildSkillChipSpec,
  type SkillChipPlacement,
  type SkillChipSpec,
} from "./skill-chip-markup";

/**
 * Converts the name of a markup attribute to the prop React takes for it:
 * `class` becomes `className` and `stroke-width` becomes `strokeWidth`.
 * `data-` and `aria-` attributes keep their names.
 */
const convertAttributeToProp = (attribute: string): string => {
  if (attribute === "class") return "className";
  if (attribute.startsWith("data-") || attribute.startsWith("aria-")) return attribute;
  return attribute.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
};

/**
 * Builds the React element for `spec`. `rootProps` go to the root element
 * only. A namespaced tag (`<namespace> svg`) is drawn by its bare name,
 * which React puts in the right namespace itself.
 */
const renderSpec = (spec: SkillChipSpec, rootProps: object = {}): ReactNode => {
  if (typeof spec === "string") return spec;
  const [tag, attributes, ...children] = spec;
  const props: Record<string, string> = {};
  for (const [attribute, value] of Object.entries(attributes)) {
    props[convertAttributeToProp(attribute)] = value;
  }
  return createElement(
    tag.slice(tag.indexOf(" ") + 1),
    { ...props, ...rootProps },
    ...children.map((child) => renderSpec(child)),
  );
};

/**
 * Renders the chip for the skill called `name`: its icon, then its name,
 * with a repository skill's checkout (`webshop:`) quieter. `placement` is
 * `"message"` in a sent message and a queued input, and `"composer"` (the
 * default) elsewhere. The pointer handlers are for a caller that opens a
 * hover card.
 *
 * The chip is an inline element, so its fill and padding grow past the
 * text's line without making the line taller.
 */
export function SkillChip({
  name,
  placement = "composer",
  onPointerEnter,
  onPointerLeave,
}: {
  readonly name: string;
  readonly placement?: SkillChipPlacement;
  readonly onPointerEnter?: PointerEventHandler<HTMLElement>;
  readonly onPointerLeave?: PointerEventHandler<HTMLElement>;
}): JSX.Element {
  return (
    <>
      {renderSpec(buildSkillChipSpec(name, { placement }), {
        onPointerEnter,
        onPointerLeave,
      })}
    </>
  );
}

/**
 * Renders `SkillChip` for a message, and opens the hover card of `skill`
 * while the pointer is over the chip. `skill` is the session's skill that
 * has this name, or `undefined` when the session no longer has one (the
 * skill was deleted since the message was sent): the chip then shows no card.
 */
export function HoverableSkillChip({
  name,
  skill,
}: {
  readonly name: string;
  readonly skill: SessionSkill | undefined;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <SkillChip
        name={name}
        placement="message"
        onPointerEnter={(event) => {
          setAnchor(event.currentTarget);
        }}
        onPointerLeave={() => {
          setAnchor(null);
        }}
      />
      {anchor !== null && skill !== undefined ? (
        <SkillHoverCard skill={skill} anchor={anchor} />
      ) : null}
    </>
  );
}
