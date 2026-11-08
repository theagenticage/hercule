/**
 * Tests the hand-off chain and its reverse on a card drawn the way the Inbox
 * draws one: that the pieces start in the order the motion design gives, that
 * Undo waits for the mark to be home, and above all that cancelling stops every
 * piece, so a late end of an animation never replays a hand-off that was
 * reversed. jsdom has no layout and no Web Animations, so the tests give the
 * elements rectangles and read the animations that are asked for.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installFakeAnimations,
  removeFakeAnimations,
  type FakeAnimation,
} from "../../app/motion/testing-animations";
import { createHandOffChains, type HandOffChains } from "./hand-off-motion";

let played: FakeAnimation[];
let chains: HandOffChains;

const setReduced = (reduced: boolean): void => {
  document.documentElement.style.setProperty("--dur-2", reduced ? "0s" : "200ms");
};

const place = (
  element: Element,
  left: number,
  top: number,
  width: number,
  height = width,
): void => {
  element.getBoundingClientRect = () => new DOMRect(left, top, width, height);
};

/** Draws Overview's row with its icon. */
const drawOverview = (): SVGElement => {
  const row = document.body.appendChild(document.createElement("a"));
  row.dataset["motionTarget"] = "overview";
  place(row, 8, 96, 200, 30);
  const icon = row.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
  place(icon, 20, 100, 16);
  return icon;
};

interface DrawnCard {
  readonly card: HTMLElement;
  readonly colleague: HTMLElement | null;
  readonly mark: HTMLElement;
}

const CARD_ID = "card-1";

/**
 * Fills `card` with a mark, a line with a sentence, and, when `handed`, the
 * colleague that has it in the wait's place. A card that is not handed shows
 * its wait (`3d`) there instead. Filling a card again is how React redraws it
 * in place.
 */
const fillCard = (card: HTMLElement, sentence: string, handed: boolean): DrawnCard => {
  card.replaceChildren();
  const mark = card.appendChild(document.createElement("span"));
  mark.dataset["handOffMark"] = "";
  place(mark, 320, 210, 15);
  const line = card.appendChild(document.createElement("span"));
  line.dataset["landingLine"] = "";
  place(line, 360, 210, 400, 16);
  const words = line.appendChild(document.createElement("span"));
  words.dataset["landingSentence"] = "";
  words.textContent = sentence;
  place(words, 360, 210, 200, 16);
  let colleague: HTMLElement | null = null;
  if (!handed) {
    const wait = card.appendChild(document.createElement("span"));
    wait.dataset["level"] = "recent";
    wait.setAttribute("title", "waiting 3 days");
    wait.textContent = "3d";
    place(wait, 860, 208, 22);
  } else {
    const box = card.appendChild(document.createElement("span"));
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", "Agent review has it");
    place(box, 860, 208, 22);
    colleague = box.appendChild(document.createElement("span"));
    colleague.dataset["handOffColleague"] = "";
  }
  return { card, colleague, mark };
};

/** Draws a card on the page. */
const drawCard = (sentence: string, handed: boolean, parent: HTMLElement = document.body) => {
  const card = parent.appendChild(document.createElement("div"));
  card.dataset["cardId"] = CARD_ID;
  place(card, 300, 200, 600, 40);
  return fillCard(card, sentence, handed);
};

/**
 * Draws a card that has no mark of its own, as a row does when the head of its
 * place already shows the plugin's mark, inside that place. Returns the card
 * and the place's mark.
 */
const drawCardUnderPlaceMark = (sentence: string, handed: boolean) => {
  const surface = document.body.appendChild(document.createElement("section"));
  surface.className = "inbox-place";
  const placeMark = surface.appendChild(document.createElement("span"));
  placeMark.className = "place-mark";
  place(placeMark, 330, 120, 16);
  const { card } = drawCard(sentence, handed, surface);
  card.querySelector("[data-hand-off-mark]")?.remove();
  return { card, placeMark };
};

/**
 * Plays a change on the card the way the Inbox does: the page draws the card
 * again, in place, inside the call, and the chain plays on it.
 */
const change = (
  card: HTMLElement,
  direction: "forwards" | "backwards",
  sentence: string,
  handed: boolean,
): void => {
  chains.play(document.body, CARD_ID, direction, () => {
    fillCard(card, sentence, handed);
    if (card.closest(".inbox-place") !== null) card.querySelector("[data-hand-off-mark]")?.remove();
  });
};

/** Returns the animations that were started and not cancelled. */
const listRunning = (): FakeAnimation[] => played.filter((animation) => !animation.isCancelled);

beforeEach(() => {
  played = installFakeAnimations();
  chains = createHandOffChains();
  setReduced(false);
});

afterEach(() => {
  removeFakeAnimations();
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--dur-2");
});

const readColleague = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>("[data-hand-off-colleague]");

describe("handing a card on", () => {
  it("lifts the colleague at once, then takes the weight, rolls the sentence and flies the mark at 170ms", () => {
    drawOverview();
    const { card } = drawCard("Opened by Sam", false);

    change(card, "forwards", "Agent review has it", true);

    expect(readColleague(card)?.style.transform).toContain("translate3d(0.00px,22.00px,0)");
    const delays = played.map((animation) => animation.options.delay);
    // The knock of the colleague, the flight of the mark and the dimming of the mark all wait for 170ms.
    expect(delays.filter((delay) => delay === 170).length).toBeGreaterThanOrEqual(3);
  });

  it("flies the mark of the place's head when the card has none of its own", () => {
    drawOverview();
    const { card, placeMark } = drawCardUnderPlaceMark("Opened by Sam", false);

    change(card, "forwards", "Agent review has it", true);

    // The place's mark is dimmed where it stands while its copy flies.
    expect(played.some((animation) => animation.element === placeMark)).toBe(true);
    expect(played.some((animation) => animation.element.closest(".motion-flights"))).toBe(true);
  });

  it("fades a copy of the wait away over 120ms, and removes it when the fade ends", () => {
    drawOverview();
    const { card } = drawCard("Opened by Sam", false);

    change(card, "forwards", "Agent review has it", true);

    const copy = card.querySelector("[data-level]");
    expect(copy?.textContent).toBe("3d");
    expect(copy?.getAttribute("aria-hidden")).toBe("true");
    expect(copy?.hasAttribute("title")).toBe(false);
    const fade = played.find((animation) => animation.element === copy);
    expect(fade?.options.duration).toBe(120);
    fade?.finish();
    expect(card.querySelector("[data-level]")).toBeNull();
  });

  it("shows the colleague at once and fades Overview's row under Reduce motion", () => {
    setReduced(true);
    const icon = drawOverview();
    const { card } = drawCard("Opened by Sam", false);

    change(card, "forwards", "Agent review has it", true);

    expect(readColleague(card)?.style.transform).toBe("");
    expect(played).toHaveLength(1);
    expect(played[0]?.options.duration).toBe(400);
    expect(played.some((animation) => animation.element === icon)).toBe(false);
  });

  it("only commits when the page has no such card", () => {
    let committed = false;
    chains.play(document.body, "missing", "forwards", () => {
      committed = true;
    });

    expect(committed).toBe(true);
    expect(played).toEqual([]);
  });
});

describe("taking a hand-off back", () => {
  it("waits for the mark to be home before the card stands up, the sentence rolls back and the colleague sinks", () => {
    drawOverview();
    const { card } = drawCard("Agent review has it", true);

    change(card, "backwards", "Opened by Sam", false);

    const standUp = played.find((animation) => animation.element === card);
    expect(standUp?.options.delay).toBe(240);
    // The colleague's copy lies over the card until it has sunk, and is no second "has it" for a screen reader.
    const copy = card.querySelector("[aria-hidden]");
    expect(copy).not.toBeNull();
    expect(copy?.hasAttribute("role")).toBe(false);
    expect(readColleague(card)).toBeNull();
  });

  it("flies the place's mark home when the card has none of its own", () => {
    drawOverview();
    const { card } = drawCardUnderPlaceMark("Agent review has it", true);

    change(card, "backwards", "Opened by Sam", false);

    expect(played.some((animation) => animation.element.closest(".motion-flights"))).toBe(true);
    expect(played.find((animation) => animation.element === card)?.options.delay).toBe(240);
  });

  it("starts the rest at once when the sidebar shows no Overview to fly from", () => {
    const { card } = drawCard("Agent review has it", true);

    change(card, "backwards", "Opened by Sam", false);

    expect(played.find((animation) => animation.element === card)?.options.delay).toBe(0);
  });

  it("plays nothing under Reduce motion", () => {
    drawOverview();
    const { card } = drawCard("Agent review has it", true);
    setReduced(true);

    change(card, "backwards", "Opened by Sam", false);

    expect(played).toEqual([]);
    expect(card.querySelector("[aria-hidden]")).toBeNull();
  });
});

describe("a second change on the same card", () => {
  it("cuts the chain still playing short: every piece stops, and a flight that ends late plays no receipt", () => {
    const icon = drawOverview();
    const { card } = drawCard("Opened by Sam", false);
    change(card, "forwards", "Agent review has it", true);
    const copyFlight = played.find((animation) => animation.element.closest(".motion-flights"));
    const before = played.length;

    change(card, "forwards", "Agent review has it", true);
    copyFlight?.finish();

    // Everything the first chain started is stopped. What is running was started by the second.
    expect(listRunning().every((animation) => played.indexOf(animation) >= before)).toBe(true);
    expect(played.some((animation) => animation.element === icon)).toBe(false);
  });

  it("stops every chain and lets go of the card when the page that owns them goes away", () => {
    const icon = drawOverview();
    const { card } = drawCard("Opened by Sam", false);
    change(card, "forwards", "Agent review has it", true);
    const copyFlight = played.find((animation) => animation.element.closest(".motion-flights"));

    chains.stopAll();
    copyFlight?.finish();

    expect(listRunning()).toEqual([]);
    expect(played.some((animation) => animation.element === icon)).toBe(false);
    expect(document.querySelector(".motion-flights")).toBeNull();
  });
});
