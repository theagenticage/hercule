/**
 * The markup of a skill chip, defined once. The composer's editor draws a
 * chip with ProseMirror's `renderHTML`, which runs without React, and a sent
 * message and a queued input draw it with React. Both start from
 * `buildSkillChipSpec`, so the places cannot drift apart: the editor returns
 * the spec from `renderHTML` (skill-chip-extension.ts), and `SkillChip`
 * (skill-chip.tsx) turns the same spec into React elements.
 *
 * The chip's CSS is imported here, so whoever draws a chip gets its style.
 */
import "./skill-chip.css";

/** Where a chip is drawn. A chip in a message or a queued input steps one tone darker than one in the composer. */
export type SkillChipPlacement = "composer" | "message";

/**
 * An element of the chip's markup: `[tag, attributes, ...children]`. It has
 * the shape of ProseMirror's `DOMOutputSpec`, so the editor can return it
 * from `renderHTML`. A tag with a namespace is written `"<namespace> <tag>"`,
 * as ProseMirror writes it.
 */
export type SkillChipElementSpec = readonly [
  tag: string,
  attributes: Readonly<Record<string, string>>,
  ...children: SkillChipSpec[],
];

/** A node of the chip's markup: a text, or an element. */
export type SkillChipSpec = string | SkillChipElementSpec;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The skill icon, as `SkillIcon` (icons/skill.tsx) draws it: a page with a
 * four-pointed star at its top right corner. The chip's test fails when the
 * two stop matching.
 */
const SKILL_ICON_SPEC: SkillChipElementSpec = [
  `${SVG_NAMESPACE} svg`,
  {
    class: "ic",
    viewBox: "0 0 16 16",
    width: "16",
    height: "16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  },
  [
    `${SVG_NAMESPACE} path`,
    {
      d: "M8.4 2.8H4.8a1.2 1.2 0 0 0-1.2 1.2v8a1.2 1.2 0 0 0 1.2 1.2h6.4a1.2 1.2 0 0 0 1.2-1.2V7.6",
    },
  ],
  [
    `${SVG_NAMESPACE} path`,
    {
      d: "M11.8 1.6c.2 1.1.9 1.8 2 2-1.1.2-1.8.9-2 2-.2-1.1-.9-1.8-2-2 1.1-.2 1.8-.9 2-2z",
    },
  ],
  [`${SVG_NAMESPACE} path`, { d: "M6 8.2h4M6 10.6h2.6" }],
];

/**
 * Splits a skill's name into its checkout part and its skill part. A
 * repository skill is `<checkout>:<skill>` (`webshop:release`) and a Skill
 * Library skill has no colon, so its checkout part is empty. The checkout
 * part keeps its colon (`webshop:`) so the two parts join back into the name.
 */
export const splitSkillName = (
  name: string,
): { readonly checkout: string; readonly skill: string } => {
  const colon = name.indexOf(":");
  return { checkout: name.slice(0, colon + 1), skill: name.slice(colon + 1) };
};

/**
 * Builds the markup of the chip for the skill called `name`: the icon, then
 * the name. A repository skill's checkout (`webshop:`) is in a span of its
 * own, which the stylesheet draws quieter.
 *
 * The chip carries `data-skill`, the full name, so the editor can find the
 * chip under the pointer and look the skill up.
 *
 * A chip in a message also holds the `$` of its Skill Reference, drawn at no
 * size (`.skill-sigil`). The reader sees the name alone, as in the composer,
 * but a selection that holds the chip copies `$name`, which the composer turns
 * into a chip again when it is pasted. The composer's own chip has no sigil:
 * its editor writes `$name` itself when its content is copied.
 */
export const buildSkillChipSpec = (
  name: string,
  { placement = "composer" }: { readonly placement?: SkillChipPlacement } = {},
): SkillChipElementSpec => {
  const { checkout, skill } = splitSkillName(name);
  return [
    "span",
    {
      class: "skill-chip",
      "data-skill": name,
      "data-placement": placement,
    },
    SKILL_ICON_SPEC,
    ...(placement === "message" ? [["span", { class: "skill-sigil" }, "$"] as const] : []),
    ...(checkout === "" ? [] : [["span", { class: "skill-label-checkout" }, checkout] as const]),
    skill,
  ];
};
