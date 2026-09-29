import { describe, expect, it } from "vitest";
import { buildDefaultWindowBounds, placeWindowOnDisplays } from "./window-placement";

// A 14" MacBook Pro's built-in display, its work area below the menu bar,
// and a 4K display to its right, its top edge level with the laptop's.
const laptop = { workArea: { x: 0, y: 38, width: 1512, height: 944 } };
const external = { workArea: { x: 1512, y: 25, width: 2560, height: 1415 } };

describe("buildDefaultWindowBounds", () => {
  it("centres a 1440 by 900 window in a work area that has room for it", () => {
    expect(buildDefaultWindowBounds(laptop.workArea)).toEqual({
      x: 36,
      y: 60,
      width: 1440,
      height: 900,
    });
  });

  it("fills a work area smaller than 1440 by 900", () => {
    const small = { x: 0, y: 25, width: 1280, height: 775 };
    expect(buildDefaultWindowBounds(small)).toEqual(small);
  });

  it("shrinks only the dimension that does not fit", () => {
    expect(buildDefaultWindowBounds({ x: 0, y: 25, width: 1920, height: 800 })).toEqual({
      x: 240,
      y: 25,
      width: 1440,
      height: 800,
    });
  });
});

describe("placeWindowOnDisplays", () => {
  it("keeps a window that lies on a display", () => {
    const saved = { x: 100, y: 80, width: 1200, height: 800 };
    expect(placeWindowOnDisplays(saved, [laptop, external])).toEqual(saved);
  });

  it("keeps a window that hangs partly off a display", () => {
    const saved = { x: 1300, y: 500, width: 1200, height: 800 };
    expect(placeWindowOnDisplays(saved, [laptop])).toEqual(saved);
  });

  it("shrinks a window saved on a larger display into the work area it lands on", () => {
    const workArea = { x: 0, y: 0, width: 1512, height: 982 };
    const saved = { x: 0, y: 0, width: 2560, height: 1440 };
    expect(placeWindowOnDisplays(saved, [{ workArea }])).toEqual(workArea);
  });

  it("shrinks a window too big for both displays it spans into the one it overlaps most", () => {
    const saved = { x: 1000, y: 25, width: 3000, height: 1500 };
    expect(placeWindowOnDisplays(saved, [laptop, external])).toEqual({ ...external.workArea });
  });

  it("never shrinks a window below the minimum size", () => {
    const tiny = { workArea: { x: 0, y: 0, width: 640, height: 400 } };
    const saved = { x: 5000, y: 0, width: 1000, height: 700 };
    expect(placeWindowOnDisplays(saved, [tiny])).toEqual({ x: 0, y: 0, width: 800, height: 500 });
  });

  it("moves a window from a display that is gone onto the nearest one, beside where it was", () => {
    const saved = { x: 2000, y: 300, width: 1200, height: 800 };
    expect(placeWindowOnDisplays(saved, [laptop])).toEqual({
      x: 312,
      y: 182,
      width: 1200,
      height: 800,
    });
  });

  it("shrinks a moved window that is bigger than the work area it lands in", () => {
    const saved = { x: 1800, y: 100, width: 2400, height: 1300 };
    expect(placeWindowOnDisplays(saved, [laptop])).toEqual({ ...laptop.workArea });
  });

  it("chooses the display nearest to the saved position", () => {
    const leftOfLaptop = { x: -3000, y: 100, width: 1000, height: 700 };
    const rightOfExternal = { x: 5000, y: 100, width: 1000, height: 700 };
    expect(placeWindowOnDisplays(leftOfLaptop, [external, laptop])).toEqual({
      x: 0,
      y: 100,
      width: 1000,
      height: 700,
    });
    expect(placeWindowOnDisplays(rightOfExternal, [laptop, external])).toEqual({
      x: 3072,
      y: 100,
      width: 1000,
      height: 700,
    });
  });

  it("moves a window that only touches a display's edge", () => {
    const saved = { x: -1000, y: 100, width: 1000, height: 700 };
    expect(placeWindowOnDisplays(saved, [laptop])).toEqual({ ...saved, x: 0 });
  });

  it("moves a window hidden above the menu bar down into the work area", () => {
    const saved = { x: 100, y: -900, width: 1000, height: 700 };
    expect(placeWindowOnDisplays(saved, [laptop])).toEqual({ ...saved, y: 38 });
  });
});
