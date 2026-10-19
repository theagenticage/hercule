/**
 * Tests the `$` and `/` lists as the editor drives them: what a row shows,
 * the empty state, the highlighted row, picking, and that a press on the
 * list leaves focus in the editor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("numbers each option in the whole list, for a screen reader", () => {
    renderList();
    expect(
      screen
        .getAllByRole("option")
        .map((option) => [
          option.getAttribute("aria-posinset"),
          option.getAttribute("aria-setsize"),
        ]),
    ).toEqual([
      ["1", "3"],
      ["2", "3"],
      ["3", "3"],
    ]);
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

  it("says the skills are being read, and not that the thread has none, while they are unknown", () => {
    renderList({ skills: [], unavailable: { status: "reading" } });
    expect(screen.getByText("Reading skills…")).toBeTruthy();
    expect(screen.queryByText("This thread has no skills")).toBeNull();
    expect(screen.queryByText(/Skills come from the Skill Library/)).toBeNull();
  });

  it("says the skills could not be read, and why, when the read failed", () => {
    renderList({
      skills: [],
      kind: "commands",
      unavailable: { status: "failed", message: "The runner is offline." },
    });
    expect(screen.getByText("Couldn't read this thread's skills")).toBeTruthy();
    expect(screen.getByText("The runner is offline.")).toBeTruthy();
    expect(screen.queryByText("This thread has no commands")).toBeNull();
  });

  it("draws the rows, not the notice, when it has rows to show", () => {
    renderList({ unavailable: { status: "failed", message: "The runner is offline." } });
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByText("Couldn't read this thread's skills")).toBeNull();
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

describe("a long skill list", () => {
  const MANY = Array.from({ length: 120 }, (_, index) => ({
    source: "library",
    name: `skill-${String(index)}`,
    description: `Does thing ${String(index)}`,
  })) as unknown as ReadonlyArray<SessionSkill>;

  const getListbox = () => screen.getByRole("listbox");

  it("draws only the rows near the top, in a list as tall as all of them", () => {
    const { container } = render(
      <SkillList
        kind="skills"
        skills={MANY}
        query=""
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onPick={vi.fn()}
        id="many"
      />,
    );
    const options = screen.getAllByRole("option");
    // 7.5 rows are visible, and 4 more are drawn below them.
    expect(options.map((option) => option.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `many-${String(index)}`),
    );
    expect(getListbox().firstElementChild).toHaveProperty("style.height", "3840px");
    expect(options[11]!.getAttribute("aria-setsize")).toBe("120");
    expect(options[11]!.getAttribute("aria-posinset")).toBe("12");
    expect(
      container
        .querySelector<HTMLElement>(".composer-skill-list")!
        .style.getPropertyValue("--composer-skill-list-row"),
    ).toBe("32px");
  });

  it("draws the highlighted row wherever it is, with an empty gap before it", () => {
    render(
      <SkillList
        kind="skills"
        skills={MANY}
        query=""
        activeIndex={100}
        onActiveIndexChange={vi.fn()}
        onPick={vi.fn()}
        id="many"
      />,
    );
    const active = screen.getByRole("option", { selected: true });
    expect(active.id).toBe("many-100");
    expect(active.previousElementSibling).toHaveProperty("style.height", `${String(88 * 32)}px`);
    expect(screen.queryByText("Does thing 50")).toBeNull();
  });

  describe("scrolls the highlighted row into view", () => {
    // The list is 245px tall inside: 246px less the hairline above its rows.
    const VIEWPORT = 245;
    const ROW = 32;
    const EDGE = 6;

    const renderAt = (activeIndex: number, scrollTop: number) => {
      // Starts on another row, because the list scrolls when the highlighted row changes.
      const startRow = activeIndex === 0 ? 5 : 0;
      const props = {
        kind: "skills" as const,
        skills: MANY,
        query: "",
        onActiveIndexChange: vi.fn(),
        onPick: vi.fn(),
        id: "many",
      };
      const view = render(<SkillList {...props} activeIndex={startRow} />);
      getListbox().scrollTop = scrollTop;
      view.rerender(<SkillList {...props} activeIndex={activeIndex} />);
      return getListbox();
    };

    beforeEach(() => {
      vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(VIEWPORT);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("scrolls up to the very top for the first row, so the padding shows", () => {
      expect(renderAt(0, 500).scrollTop).toBe(0);
    });

    it("scrolls down just far enough to clear the row's bottom edge by the padding", () => {
      expect(renderAt(10, 0).scrollTop).toBe(EDGE + 11 * ROW + EDGE - VIEWPORT);
    });

    it("scrolls up just far enough to clear the row's top edge by the padding", () => {
      expect(renderAt(20, 3000).scrollTop).toBe(20 * ROW);
    });

    it("leaves a row that is in view where it is", () => {
      expect(renderAt(3, 40).scrollTop).toBe(40);
    });

    it("scrolls to the bottom for the last row, so the padding shows", () => {
      expect(renderAt(119, 0).scrollTop).toBe(EDGE + 120 * ROW + EDGE - VIEWPORT);
    });
  });
});
