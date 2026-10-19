/**
 * Tests the `$` and `/` lists as the editor drives them: what a row shows,
 * the empty state, the highlighted row, picking, and that a press on the
 * list leaves focus in the editor.
 */
import { describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import type { SessionSkill } from "@hercule/contract";
import { buildSkillOptionId, SkillList } from "./skill-list";

const SKILLS = [
  { source: "library", name: "implement", description: "Implement a locked SPEC" },
  { source: "library", name: "review", description: "Review a diff" },
  {
    source: "repository",
    name: "webshop:release",
    description: "Walk the release checklist",
    path: "webshop/.claude/skills/release",
  },
] as unknown as ReadonlyArray<SessionSkill>;

const renderList = (over: Partial<React.ComponentProps<typeof SkillList>> = {}) => {
  const props = {
    kind: "skills" as const,
    skills: SKILLS,
    query: "",
    activeIndex: 0,
    onActiveIndexChange: vi.fn<(index: number) => void>(),
    onPick: vi.fn<(skill: SessionSkill) => void>(),
    id: "skills-list",
    ...over,
  };
  render(<SkillList {...props} />);
  return props;
};

describe("the skill list", () => {
  it("shows a row per skill with its name, description and source", () => {
    renderList();
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "implementImplement a locked SPECLibrary",
      "reviewReview a diffLibrary",
      "webshop:releaseWalk the release checklistRepository",
    ]);
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeTruthy();
  });

  it("gives each option a stable id for aria-activedescendant", () => {
    renderList();
    expect(screen.getAllByRole("option").map((option) => option.id)).toEqual([
      "skills-list-0",
      "skills-list-1",
      "skills-list-2",
    ]);
    expect(buildSkillOptionId("skills-list", 2)).toBe("skills-list-2");
  });

  it("marks the active row as selected", () => {
    renderList({ activeIndex: 1 });
    expect(
      screen.getAllByRole("option").map((option) => option.getAttribute("aria-selected")),
    ).toEqual(["false", "true", "false"]);
  });

  it("scrolls the active row into view", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    renderList({ activeIndex: 2 });
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
    expect(scroll.mock.contexts[0]).toBe(screen.getAllByRole("option")[2]);
    scroll.mockRestore();
  });

  it("marks where the query matches a description", () => {
    renderList({ query: "diff", skills: [SKILLS[1]!] });
    expect(screen.getByRole("option").querySelector("mark")?.textContent).toBe("diff");
  });

  it("labels each command row /skill:<name>", () => {
    renderList({ kind: "commands" });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    expect(
      screen.getAllByRole("option").map((option) => option.textContent?.split(/(?=[A-Z])/)[0]),
    ).toEqual(["/skill:implement", "/skill:review", "/skill:webshop:release"]);
  });

  it("names the query when no skill matches", () => {
    renderList({ skills: [], query: "zzz" });
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.getByText("No skill matches “zzz”")).toBeTruthy();
    expect(screen.getByText(/Skills come from the Skill Library/)).toBeTruthy();
  });

  it("says so when the thread has no skills at all", () => {
    renderList({ skills: [], kind: "commands" });
    expect(screen.getByText("This thread has no commands")).toBeTruthy();
  });

  it("picks the skill of the row that is clicked", () => {
    const { onPick } = renderList();
    fireEvent.click(screen.getByRole("option", { name: /webshop:release/ }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(SKILLS[2]);
  });

  it("highlights the row the pointer moves over, and only when it is another row", () => {
    const { onActiveIndexChange } = renderList();
    const options = screen.getAllByRole("option");
    fireEvent.pointerMove(options[0]!);
    expect(onActiveIndexChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(options[2]!);
    expect(onActiveIndexChange).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("keeps focus in the editor when a row or the head is pressed", () => {
    renderList();
    const row = screen.getAllByRole("option")[1]!;
    for (const target of [row, within(row.closest(".composer-skill-list")!).getByText("Skills")]) {
      const event = createEvent.mouseDown(target);
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("makes no row focusable", () => {
    renderList();
    for (const option of screen.getAllByRole("option"))
      expect(option.hasAttribute("tabindex")).toBe(false);
  });
});
