import { afterEach, describe, expect, it } from "vitest";
import { markCardDent, readSheetOrigin, type TaskPlace } from "./pane-anchor";

afterEach(() => {
  document.body.replaceChildren();
});

const PLACE: TaskPlace = {
  taskId: "t1",
  laneId: "lane-1",
  cellId: "lane-1/planned",
  stage: "planned",
};

/** Gives `element` a size on screen, which jsdom does not lay out. */
const place = (element: Element, top: number, height = 90): void => {
  element.getBoundingClientRect = () => new DOMRect(100, top, 200, height);
};

/** Builds an element with these attributes and children, so the tests set no markup from a string. */
const make = (
  tag: string,
  attributes: Readonly<Record<string, string>> = {},
  ...children: ReadonlyArray<Node | string>
): HTMLElement => {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children);
  return element;
};

/** Builds a scroller 600px tall at the top of the window, with the given parts inside it. */
const buildScroller = (...parts: ReadonlyArray<Node>): HTMLElement => {
  const scroller = make("div", {}, ...parts);
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 600);
  document.body.append(scroller);
  return scroller;
};

describe("readSheetOrigin", () => {
  it("grows from the card on screen, with a copy of its words that is hidden from assistive technology and has no id to repeat", () => {
    const scroller = buildScroller(
      make(
        "div",
        {
          role: "button",
          tabindex: "0",
          "data-card-id": "t1",
          "data-away": "",
          class: "desk-card is-focus",
        },
        make("p", {}, "Words"),
      ),
    );
    const card = scroller.querySelector("[data-card-id]")!;
    place(card, 200);

    const origin = readSheetOrigin(scroller, PLACE);

    expect(origin.rect).toMatchObject({ top: 200, height: 90 });
    expect(origin.words?.textContent).toBe("Words");
    expect(origin.words?.getAttribute("aria-hidden")).toBe("true");
    expect(origin.words?.hasAttribute("data-card-id")).toBe(false);
    expect(origin.words?.hasAttribute("data-away")).toBe(false);
    expect(origin.words?.classList.contains("is-focus")).toBe(false);
  });

  it("grows from the line that holds the card when the card is scrolled out of view, never toward the card", () => {
    const scroller = buildScroller(
      make("div", { "data-card-id": "t1" }),
      make("button", { "data-more-cell-id": "lane-1/planned" }),
    );
    place(scroller.querySelector("[data-card-id]")!, 2000);
    place(scroller.querySelector("[data-more-cell-id]")!, 300, 30);

    const origin = readSheetOrigin(scroller, PLACE);

    expect(origin.rect).toMatchObject({ top: 300, height: 30 });
    expect(origin.words).toBeNull();
  });

  it("grows from the count on a folded lane's line when no card or line shows", () => {
    const scroller = buildScroller(
      make(
        "section",
        { "data-lane-id": "lane-1" },
        make("div", { "data-fold-row": "lane-1" }, make("span", { "data-stage": "planned" })),
      ),
    );
    place(scroller.querySelector("[data-stage]")!, 120, 20);

    expect(readSheetOrigin(scroller, PLACE).rect).toMatchObject({ top: 120, height: 20 });
  });

  it("has no origin when nothing shows, or when the board does not have the Task", () => {
    const scroller = buildScroller(make("div", { "data-card-id": "t1" }));
    place(scroller.querySelector("[data-card-id]")!, 2000);

    expect(readSheetOrigin(scroller, PLACE)).toEqual({ rect: null, words: null });
    expect(readSheetOrigin(scroller, null)).toEqual({ rect: null, words: null });
    expect(readSheetOrigin(null, PLACE)).toEqual({ rect: null, words: null });
  });

  it("does not count a card under the sticky stage headers as shown", () => {
    const scroller = buildScroller(
      make("div", { class: "board-rule-wrap" }),
      make("div", { "data-card-id": "t1" }),
    );
    place(scroller.querySelector(".board-rule-wrap")!, 0, 90);
    place(scroller.querySelector("[data-card-id]")!, 10, 60);

    expect(readSheetOrigin(scroller, PLACE).rect).toBeNull();
  });
});

describe("markCardDent", () => {
  it("leaves the dent on the card of the Task, moves it to another, and takes it away", () => {
    const scroller = buildScroller(
      make("div", { "data-card-id": "t1" }),
      make("div", { "data-card-id": "t2" }),
    );
    const [first, second] = [...scroller.querySelectorAll("[data-card-id]")];

    markCardDent(scroller, "t1");
    expect(first?.hasAttribute("data-away")).toBe(true);

    markCardDent(scroller, "t2");
    expect(first?.hasAttribute("data-away")).toBe(false);
    expect(second?.hasAttribute("data-away")).toBe(true);

    markCardDent(scroller, null);
    expect(scroller.querySelector("[data-away]")).toBeNull();
  });
});
