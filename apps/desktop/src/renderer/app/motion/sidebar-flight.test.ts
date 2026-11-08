/**
 * Tests the flight of a mark to the sidebar and back through its two
 * functions: when a flight is drawn and when it is skipped, what lands and
 * when, and that cancelling leaves nothing behind, not even a receipt for a
 * flight that never landed. jsdom has no layout and no Web Animations, so the
 * tests give the elements rectangles and read the animations that are asked for.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flyHomeFromSidebarTarget, flyToSidebarTarget } from "./index";
import {
  installFakeAnimations,
  removeFakeAnimations,
  type FakeAnimation,
} from "./testing-animations";

let played: FakeAnimation[];

const setReduced = (reduced: boolean): void => {
  document.documentElement.style.setProperty("--dur-2", reduced ? "0s" : "200ms");
};

/** Gives `element` a rectangle, as a browser's layout would. */
const place = (element: Element, left: number, top: number, size: number): void => {
  element.getBoundingClientRect = () => new DOMRect(left, top, size, size);
};

/** Draws Overview's row with an icon at 20, 100, or an icon that takes no room. */
const drawOverview = (iconSize = 16): { row: HTMLElement; icon: SVGElement } => {
  const row = document.body.appendChild(document.createElement("a"));
  row.dataset["motionTarget"] = "overview";
  place(row, 8, 96, 200);
  const icon = row.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
  place(icon, 20, 100, iconSize);
  return { row, icon };
};

/** Draws a card's mark far to the right and below the icon, with a data attribute a lookup could find it by. */
const drawMark = (): HTMLElement => {
  const mark = document.body.appendChild(document.createElement("span"));
  mark.dataset["handOffMark"] = "";
  place(mark, 700, 400, 15);
  return mark;
};

const findLayer = (): Element | null => document.querySelector(".motion-flights");

beforeEach(() => {
  played = installFakeAnimations();
  setReduced(false);
});

afterEach(() => {
  removeFakeAnimations();
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--dur-2");
});

describe("flying a mark to the sidebar", () => {
  it("draws nothing when the sidebar shows no such place", () => {
    const flight = flyToSidebarTarget(drawMark(), "overview");
    expect(flight.ms).toBe(0);
    expect(played).toEqual([]);
    expect(findLayer()).toBeNull();
  });

  it("draws nothing when the place's icon takes no room, as when the sidebar is collapsed", () => {
    drawOverview(0);
    const flight = flyToSidebarTarget(drawMark(), "overview");
    expect(flight.ms).toBe(0);
    expect(played).toEqual([]);
    expect(findLayer()).toBeNull();
  });

  it("flies a copy that no lookup of the card can find, for 420 to 760ms after the delay", () => {
    drawOverview();
    const mark = drawMark();
    const flight = flyToSidebarTarget(mark, "overview", 170);

    const layer = findLayer();
    expect(layer?.childElementCount).toBe(1);
    expect(layer?.querySelector("[data-hand-off-mark]")).toBeNull();
    const copyFlight = played.find((animation) => layer?.contains(animation.element));
    expect(copyFlight?.options.delay).toBe(170);
    expect(copyFlight?.options.duration).toBeGreaterThanOrEqual(420);
    expect(copyFlight?.options.duration).toBeLessThanOrEqual(760);
    expect(flight.ms).toBe(170 + Number(copyFlight?.options.duration));
  });

  it("leaves the mark behind, dimmer, while its copy is away", () => {
    drawOverview();
    const mark = drawMark();
    flyToSidebarTarget(mark, "overview");
    const dimming = played.find((animation) => animation.element === mark);
    const opacities = (dimming?.keyframes as Keyframe[]).map((frame) => frame["opacity"]);
    expect(Math.min(...opacities.map(Number))).toBeLessThan(1);
    expect(opacities.at(-1)).toBe(1);
  });

  it("gives the icon its knock and the row its wash when the copy lands, and removes everything after", () => {
    const { row, icon } = drawOverview();
    flyToSidebarTarget(drawMark(), "overview");
    const copyFlight = played.find((animation) => findLayer()?.contains(animation.element));

    copyFlight?.finish();

    expect(played.some((animation) => animation.element === icon)).toBe(true);
    const wash = played.find((animation) => findLayer()?.contains(animation.element));
    expect(wash?.options.duration).toBe(640);
    expect(row.isConnected).toBe(true);
    wash?.finish();
    expect(findLayer()).toBeNull();
  });

  it("removes the copy and plays no receipt when it is cancelled, even if the flight ends late", () => {
    const { icon } = drawOverview();
    const flight = flyToSidebarTarget(drawMark(), "overview");
    const copyFlight = played.find((animation) => findLayer()?.contains(animation.element));
    const before = played.length;

    flight.cancel();
    copyFlight?.finish();

    expect(findLayer()).toBeNull();
    expect(played).toHaveLength(before);
    expect(played.some((animation) => animation.element === icon)).toBe(false);
    expect(played.every((animation) => animation.isCancelled)).toBe(true);
  });

  it("flies no mark under Reduce motion, and fades the row for 400ms at once", () => {
    setReduced(true);
    const { icon } = drawOverview();
    const flight = flyToSidebarTarget(drawMark(), "overview", 170);

    expect(flight.ms).toBe(0);
    expect(played).toHaveLength(1);
    expect(played[0]?.options.duration).toBe(400);
    expect(played[0]?.options.delay).toBeUndefined();
    expect(played.some((animation) => animation.element === icon)).toBe(false);
    flight.cancel();
    expect(findLayer()).toBeNull();
  });
});

describe("flying a mark home from the sidebar", () => {
  it("takes 240ms and gives the row no receipt", () => {
    const { icon } = drawOverview();
    const flight = flyHomeFromSidebarTarget(drawMark(), "overview");
    const copyFlight = played.find((animation) => findLayer()?.contains(animation.element));

    expect(flight.ms).toBe(240);
    expect(copyFlight?.options.duration).toBe(240);
    copyFlight?.finish();
    expect(played.some((animation) => animation.element === icon)).toBe(false);
    expect(findLayer()).toBeNull();
  });

  it("draws nothing, and takes no time, without a place to fly from or under Reduce motion", () => {
    expect(flyHomeFromSidebarTarget(drawMark(), "overview").ms).toBe(0);
    drawOverview();
    setReduced(true);
    expect(flyHomeFromSidebarTarget(drawMark(), "overview").ms).toBe(0);
    expect(played).toEqual([]);
  });
});
