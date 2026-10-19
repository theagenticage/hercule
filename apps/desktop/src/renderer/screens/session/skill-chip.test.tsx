/**
 * Tests the skill chip: that React and the editor's plain DOM draw the same
 * markup, that the icon is the app's skill icon, and that the hover card
 * opens for a skill the session has and for no other.
 */
import { DOMSerializer } from "@tiptap/pm/model";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { SessionSkill } from "@hercule/contract";
import { SkillIcon } from "../../icons/skill";
import { HoverableSkillChip, SkillChip } from "./skill-chip";
import { buildSkillChipElement, buildSkillChipSpec, splitSkillName } from "./skill-chip-markup";

const LIBRARY_SKILL = {
  source: "library",
  name: "review",
  description: "Review a diff with independent reviewers",
} as unknown as SessionSkill;
const REPOSITORY_SKILL = {
  source: "repository",
  name: "webshop:release",
  description: "Walk the release checklist",
  path: "webshop/.claude/skills/release",
} as unknown as SessionSkill;

describe("the chip's markup", () => {
  it.each([
    ["a library skill", "review", undefined],
    ["a repository skill", "webshop:release", undefined],
    ["a chip in a message", "review", { placement: "message" as const }],
  ])("is the same in React and in the editor's DOM for %s", (_label, name, options) => {
    const { container } = render(<SkillChip name={name} {...options} />);
    expect(container.innerHTML).toBe(buildSkillChipElement(name, options).outerHTML);
  });

  it("is the same when ProseMirror builds it from the spec", () => {
    const { dom } = DOMSerializer.renderSpec(document, buildSkillChipSpec("webshop:release"));
    expect(dom.outerHTML).toBe(buildSkillChipElement("webshop:release").outerHTML);
  });

  it("draws the icon the app draws for a skill", () => {
    const icon = buildSkillChipElement("review").querySelector("svg")!;
    expect(icon.outerHTML).toBe(renderToStaticMarkup(<SkillIcon />));
  });

  it("carries the skill's full name for the editor to find", () => {
    expect(buildSkillChipElement("webshop:release").dataset["skill"]).toBe("webshop:release");
  });

  it("draws a repository skill's checkout apart from its name", () => {
    const chip = buildSkillChipElement("webshop:release");
    expect(chip.querySelector(".skill-label-checkout")?.textContent).toBe("webshop:");
    expect(chip.textContent).toBe("webshop:release");
    expect(buildSkillChipElement("review").querySelector(".skill-label-checkout")).toBeNull();
  });

  it("sets no style attribute, which the Content-Security-Policy refuses", () => {
    const chip = buildSkillChipElement("review");
    expect(chip.outerHTML).not.toContain("style=");
  });

  it("splits a name at its first colon", () => {
    expect(splitSkillName("review")).toEqual({ checkout: "", skill: "review" });
    expect(splitSkillName("webshop:release")).toEqual({ checkout: "webshop:", skill: "release" });
  });
});

// jsdom cannot tell whether a popover is open, so the stylesheet's `display: none` for a closed
// one hides every card from the role queries. The card's presence in the DOM is what is tested.
const readCard = (): HTMLElement => screen.getByRole("tooltip", { hidden: true });
const queryCard = (): HTMLElement | null => screen.queryByRole("tooltip", { hidden: true });

describe("the hover card", () => {
  it("shows a library skill's name, source and description on hover", () => {
    const { container } = render(<HoverableSkillChip name="review" skill={LIBRARY_SKILL} />);
    expect(queryCard()).toBeNull();

    fireEvent.pointerEnter(container.querySelector(".skill-chip")!);
    const card = readCard();
    expect(card.textContent).toContain("review");
    expect(card.textContent).toContain("Library");
    expect(card.textContent).toContain("Review a diff with independent reviewers");
    expect(card.querySelector("code")).toBeNull();
  });

  it("shows a repository skill's folder and source", () => {
    const { container } = render(
      <HoverableSkillChip name="webshop:release" skill={REPOSITORY_SKILL} />,
    );
    fireEvent.pointerEnter(container.querySelector(".skill-chip")!);
    const card = readCard();
    expect(card.textContent).toContain("webshop:release");
    expect(card.textContent).toContain("Repository");
    expect(card.querySelector("code")?.textContent).toBe("webshop/.claude/skills/release");
  });

  it("anchors itself to the chip while it is open, and lets go afterwards", () => {
    const { container } = render(<HoverableSkillChip name="review" skill={LIBRARY_SKILL} />);
    const chip = container.querySelector<HTMLElement>(".skill-chip")!;
    fireEvent.pointerEnter(chip);
    const anchorName = chip.style.getPropertyValue("anchor-name");
    expect(anchorName).toMatch(/^--skill-hover-/);
    expect(readCard().style.getPropertyValue("position-anchor")).toBe(anchorName);

    act(() => {
      fireEvent.pointerLeave(chip);
    });
    expect(queryCard()).toBeNull();
    expect(chip.style.getPropertyValue("anchor-name")).toBe("");
  });

  it("shows no card for a skill the session no longer has", () => {
    const { container } = render(<HoverableSkillChip name="gone" skill={undefined} />);
    fireEvent.pointerEnter(container.querySelector(".skill-chip")!);
    expect(queryCard()).toBeNull();
  });
});
