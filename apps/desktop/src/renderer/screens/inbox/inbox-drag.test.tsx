/**
 * Tests linking by drag as the user does it: pressing a row, moving the
 * pointer, and letting go on a row, on nothing, or with Esc. jsdom has no
 * layout, so the rows are where the test says they are
 * (`elementFromPoint`), and it counts as Reduce motion: a copy sent home is
 * gone at once. What needs a browser (the springs, the lean, the shadow, the
 * flight into the group) is checked by looking at the running app.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubElementSize } from "../../app/testing";
import { InboxList, type InboxListActions } from "./inbox-list";
import type { InboxListEntry } from "./inbox-list-entry";
import { buildInboxRowActions, buildInboxRowView, TEST_PLUGINS } from "./inbox-row.testing";

const HEAD: InboxListEntry = {
  kind: "head",
  key: "group:1",
  view: {
    key: "group:1",
    title: "Retry a failed card payment",
    time: { kind: "none" },
    reason: { who: "Tomás", rest: "mentioned you", more: 0, quiet: false },
    sources: ["github"],
    count: "2 things",
    label: "Linked group, 2 things: Retry a failed card payment",
  },
  isOpen: true,
  tick: "none",
  unloadedCount: 0,
};

const thing = (ref: string): InboxListEntry => ({
  kind: "thing",
  key: ref,
  view: buildInboxRowView(ref),
});

/** The list: two lone things, a head and its two members, and a "Show 3 more" line. */
const ENTRIES: ReadonlyArray<InboxListEntry> = [
  thing("alpha"),
  thing("beta"),
  HEAD,
  {
    ...thing("gamma"),
    kind: "member",
    member: { isQuiet: false, isLast: false, position: 1, of: 2 },
  } as InboxListEntry,
  {
    ...thing("delta"),
    kind: "member",
    member: { isQuiet: false, isLast: true, position: 2, of: 2 },
  } as InboxListEntry,
  { kind: "more", key: "group:1:more", groupKey: "group:1", hiddenCount: 3, unloadedCount: 0 },
];

interface Setup {
  readonly links: Array<readonly [string, string]>;
  readonly answerLink: (isLinked: boolean) => Promise<void>;
  readonly scroll: HTMLElement;
  readonly row: (ref: string) => HTMLElement;
}

/** Renders the list. `pointerAt` names the row that `elementFromPoint` finds, per call. */
const renderList = (pointerAt: { current: string | null }): Setup => {
  const links: Array<readonly [string, string]> = [];
  let answer: (isLinked: boolean) => void = () => {};
  const actions: InboxListActions = {
    ...buildInboxRowActions(),
    onPickGroup: () => {},
    onToggleGroupSelect: () => {},
    onToggleGroupOpen: () => {},
    onShowMore: () => {},
    onLinkThings: (from, to) => {
      links.push([from, to]);
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    },
  };
  const { container } = render(
    <InboxList
      listId="waits"
      label="Someone waits on me"
      entries={ENTRIES}
      plugins={TEST_PLUGINS}
      currentKey="alpha"
      selection={new Set()}
      actions={actions}
      onViewportChange={() => {}}
    />,
  );
  const row = (ref: string): HTMLElement =>
    container.querySelector<HTMLElement>(`.ib-rows [data-ref="${ref}"]`)!;
  document.elementFromPoint = () => (pointerAt.current === null ? null : row(pointerAt.current));
  return {
    links,
    answerLink: async (isLinked) => {
      await act(async () => {
        answer(isLinked);
        await Promise.resolve();
      });
    },
    scroll: container.querySelector<HTMLElement>(".ib-scroll")!,
    row,
  };
};

const pointer = { pointerId: 1, isPrimary: true };

beforeEach(() => {
  stubElementSize(400, 600);
  // jsdom has no pointer capture. A held pointer is what a browser would hold.
  const held = new Set<number>();
  Element.prototype.setPointerCapture = (id: number) => void held.add(id);
  Element.prototype.releasePointerCapture = (id: number) => void held.delete(id);
  Element.prototype.hasPointerCapture = (id: number) => held.has(id);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-ib-carrying");
  vi.restoreAllMocks();
});

const press = (element: Element, x = 100, y = 100): void => {
  fireEvent.pointerDown(element, { ...pointer, clientX: x, clientY: y });
};
const moveTo = (x: number, y: number): void => {
  fireEvent.pointerMove(window, { ...pointer, clientX: x, clientY: y });
};
const letGo = (x: number, y: number): void => {
  fireEvent.pointerUp(window, { ...pointer, clientX: x, clientY: y });
};
const carried = (): Element | null => document.querySelector(".ib-carry .ib-copy");

describe("carrying a row", () => {
  it("stays a click until the pointer has moved 6px", () => {
    const where = { current: null };
    const { row } = renderList(where);
    press(row("alpha"));
    moveTo(103, 104);
    expect(carried()).toBeNull();
    letGo(103, 104);
    expect(screen.getByRole("tree")).toBeTruthy();
    expect(row("alpha").hasAttribute("data-lifted")).toBe(false);
  });

  it("lifts a copy past 6px, leaves the row in its place at a third of its weight and marks the page", () => {
    const { row } = renderList({ current: null });
    press(row("alpha"));
    moveTo(100, 107);
    const copy = carried();
    expect(copy?.textContent).toContain("Title of alpha");
    // The copy is not a second row for a lookup, the keyboard or a screen reader.
    expect(copy?.querySelector("[data-ref]")).toBeNull();
    expect(copy?.querySelector("[role]")).toBeNull();
    expect(row("alpha").isConnected).toBe(true);
    expect(row("alpha").hasAttribute("data-lifted")).toBe(true);
    expect(document.documentElement.hasAttribute("data-ib-carrying")).toBe(true);
  });

  it("lights the row under the copy, and no other row, never its own and never a Show more line", () => {
    const where: { current: string | null } = { current: null };
    const { row } = renderList(where);
    press(row("alpha"));
    moveTo(100, 110);
    where.current = "beta";
    moveTo(100, 150);
    expect(row("beta").hasAttribute("data-drop")).toBe(true);
    expect(carried()?.classList.contains("is-over")).toBe(true);
    where.current = "group:1";
    moveTo(100, 200);
    expect(row("beta").hasAttribute("data-drop")).toBe(false);
    expect(row("group:1").hasAttribute("data-drop")).toBe(true);
    where.current = "alpha";
    moveTo(100, 100);
    expect(row("group:1").hasAttribute("data-drop")).toBe(false);
    expect(carried()?.classList.contains("is-over")).toBe(false);
    where.current = "group:1:more";
    moveTo(100, 300);
    expect(row("group:1:more").hasAttribute("data-drop")).toBe(false);
  });

  it("links the thing carried with the row it is let go on, and holds the copy until the link shows", async () => {
    const where: { current: string | null } = { current: null };
    const { row, links, answerLink } = renderList(where);
    press(row("alpha"));
    moveTo(100, 110);
    where.current = "beta";
    moveTo(100, 150);
    letGo(100, 150);
    expect(links).toEqual([["alpha", "beta"]]);
    expect(row("beta").hasAttribute("data-drop")).toBe(false);
    expect(document.documentElement.hasAttribute("data-ib-carrying")).toBe(false);
    expect(carried()).not.toBeNull();
    // Nothing else can be picked up while the copy waits.
    press(row("beta"));
    moveTo(100, 200);
    expect(document.querySelectorAll(".ib-copy")).toHaveLength(1);
    await answerLink(true);
    expect(carried()).not.toBeNull();
  });

  it("sends the copy home when nothing was linked", async () => {
    const where: { current: string | null } = { current: null };
    const { row, answerLink } = renderList(where);
    press(row("alpha"));
    moveTo(100, 110);
    where.current = "beta";
    moveTo(100, 150);
    letGo(100, 150);
    await answerLink(false);
    expect(carried()).toBeNull();
    expect(row("alpha").hasAttribute("data-lifted")).toBe(false);
  });

  it("fades the copy where it is, and does not send it home, when a written link never changes the list", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const where: { current: string | null } = { current: null };
    const { row, answerLink } = renderList(where);
    press(row("alpha"));
    moveTo(100, 110);
    where.current = "beta";
    moveTo(100, 150);
    letGo(100, 150);
    await answerLink(true);
    expect(carried()).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(carried()).toBeNull();
    expect(row("alpha").hasAttribute("data-lifted")).toBe(false);
    vi.useRealTimers();
  });

  it("drops on a group's head as a link to the group", () => {
    const where: { current: string | null } = { current: null };
    const { row, links } = renderList(where);
    press(row("gamma"));
    moveTo(100, 110);
    where.current = "group:1";
    moveTo(100, 150);
    letGo(100, 150);
    expect(links).toEqual([["gamma", "group:1"]]);
  });

  it("links nothing and sends the copy home when let go on no row", () => {
    const { row, links } = renderList({ current: null });
    press(row("alpha"));
    moveTo(100, 110);
    letGo(100, 110);
    expect(links).toEqual([]);
    expect(carried()).toBeNull();
    expect(row("alpha").hasAttribute("data-lifted")).toBe(false);
  });

  it("sends the copy home on Esc, links nothing, and keeps the key from reaching anything else", () => {
    const where: { current: string | null } = { current: null };
    const { row, links } = renderList(where);
    press(row("alpha"));
    moveTo(100, 110);
    where.current = "beta";
    moveTo(100, 150);
    const reachedPage = vi.fn();
    window.addEventListener("keydown", reachedPage);
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", reachedPage);
    expect(links).toEqual([]);
    expect(carried()).toBeNull();
    expect(row("beta").hasAttribute("data-drop")).toBe(false);
    expect(row("alpha").hasAttribute("data-lifted")).toBe(false);
    expect(document.documentElement.hasAttribute("data-ib-carrying")).toBe(false);
    // The pointer let go afterwards links nothing either.
    letGo(100, 150);
    expect(links).toEqual([]);
    expect(reachedPage).not.toHaveBeenCalled();
  });

  it("carries nothing from a press on a button, a group's head or a Show more line", () => {
    const { row } = renderList({ current: null });
    press(row("alpha").querySelector(".ib-row-tick")!);
    moveTo(100, 120);
    letGo(100, 120);
    press(row("group:1"));
    moveTo(100, 120);
    letGo(100, 120);
    press(row("group:1:more"));
    moveTo(100, 120);
    letGo(100, 120);
    expect(carried()).toBeNull();
    expect(document.querySelector("[data-lifted]")).toBeNull();
  });

  it("puts the page back when the list goes away with a row in the hand", () => {
    const { row } = renderList({ current: null });
    press(row("alpha"));
    moveTo(100, 110);
    document.body.replaceChildren();
    expect(document.querySelector(".ib-copy")).toBeNull();
  });
});
