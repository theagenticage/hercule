/**
 * Tests when a handoff's flight takes the exit of a signal's row, and when it
 * sends the lifted copy on its way. jsdom has no Web Animations API, so the
 * test stands in for it and reads what the flight asks it to play.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandoffFlights } from "./handoff-flight";

const animate = vi.fn((): { finished: Promise<never> } => ({ finished: new Promise(() => {}) }));

beforeEach(() => {
  Object.defineProperty(Element.prototype, "animate", { value: animate, configurable: true });
  document.documentElement.style.setProperty("--dur-1", "120ms");
  document.documentElement.style.setProperty("--dur-3", "320ms");
});

afterEach(() => {
  animate.mockClear();
  document.body.replaceChildren();
});

/** Draws a layer, folded Tracking with one row, and returns them with the flights that know them. */
const setUp = (foldDrawn = true) => {
  const flights = createHandoffFlights();
  const layer = document.body.appendChild(document.createElement("div"));
  const fold = document.body.appendChild(document.createElement("section"));
  const rows = fold.appendChild(document.createElement("div"));
  const firstRow = rows.appendChild(document.createElement("div"));
  flights.setLayer(layer);
  if (foldDrawn) flights.setFold(fold);
  return { flights, layer, rows, firstRow };
};

const place = new DOMRect(10, 20, 300, 52);

describe("takeLeavingRow", () => {
  it("leaves the row to the list's fade when no handoff of it is expected", () => {
    const { flights, layer } = setUp();
    expect(flights.takeLeavingRow("signal-1", document.createElement("div"), place)).toBe(false);
    expect(layer.children).toHaveLength(0);
  });

  it("leaves the row to the list's fade while Tracking is opened, because the sheet covers the list", () => {
    const { flights, layer } = setUp(false);
    flights.expect("signal-1");
    expect(flights.takeLeavingRow("signal-1", document.createElement("div"), place)).toBe(false);
    expect(layer.children).toHaveLength(0);
  });

  it("lifts the copy of an expected row and plays nothing until the Task's row is drawn", () => {
    const { flights, layer } = setUp();
    flights.expect("signal-1");
    const copy = document.createElement("div");
    expect(flights.takeLeavingRow("signal-1", copy, place)).toBe(true);
    expect(copy.parentElement).toBe(layer);
    expect(copy.classList.contains("tr-lifted")).toBe(true);
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("land", () => {
  it("flies the copy and hides the first row once a row that names the signal is drawn", () => {
    const { flights, rows, firstRow } = setUp();
    flights.expect("signal-1");
    flights.takeLeavingRow("signal-1", document.createElement("div"), place);
    flights.land(["signal-2"], rows);
    expect(animate).not.toHaveBeenCalled();
    flights.land(["signal-1"], rows);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.contexts).toContain(firstRow);
  });

  it("flies at once when the Task's row was drawn before the signal's row left", () => {
    const { flights, rows } = setUp();
    flights.expect("signal-1");
    flights.land(["signal-1"], rows);
    expect(animate).not.toHaveBeenCalled();
    flights.takeLeavingRow("signal-1", document.createElement("div"), place);
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("flies each copy once", () => {
    const { flights, rows } = setUp();
    flights.expect("signal-1");
    flights.takeLeavingRow("signal-1", document.createElement("div"), place);
    flights.land(["signal-1"], rows);
    flights.land(["signal-1"], rows);
    expect(animate).toHaveBeenCalledTimes(2);
  });
});

describe("forget", () => {
  it("fades a lifted copy of a handoff that failed", () => {
    const { flights } = setUp();
    flights.expect("signal-1");
    const copy = document.createElement("div");
    flights.takeLeavingRow("signal-1", copy, place);
    flights.forget("signal-1");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts).toContain(copy);
  });
});
