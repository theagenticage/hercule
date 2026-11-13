/** Tests which key presses the Inbox acts on, and where it leaves them alone. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideInboxKeyAction,
  readInboxKeyPlace,
  type InboxKeyPlace,
  type InboxKeyPress,
} from "./inbox-keys";

const press = (key: string, overrides: Partial<InboxKeyPress> = {}): InboxKeyPress => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  repeat: false,
  isOnControl: false,
  ...overrides,
});

const decide = (key: string, place: InboxKeyPlace, overrides: Partial<InboxKeyPress> = {}) =>
  decideInboxKeyAction(press(key, overrides), place)?.kind ?? null;

describe("decideInboxKeyAction", () => {
  it("maps the list's keys to their actions", () => {
    expect(decideInboxKeyAction(press("j"), "list")).toEqual({
      kind: "step",
      by: 1,
      extend: false,
    });
    expect(decideInboxKeyAction(press("K", { shiftKey: true }), "list")).toEqual({
      kind: "step",
      by: -1,
      extend: true,
    });
    expect(decideInboxKeyAction(press("ArrowDown"), "list")).toEqual({
      kind: "step",
      by: 1,
      extend: false,
    });
    expect(decide("x", "list")).toBe("toggleSelect");
    expect(decide("e", "list")).toBe("dismiss");
    expect(decide("t", "list")).toBe("takeOn");
    expect(decide("h", "list")).toBe("handOff");
    expect(decide("g", "list")).toBe("goToTask");
    expect(decide("o", "list")).toBe("openAtSource");
    expect(decide("f", "list")).toBe("narrow");
    expect(decide(".", "list")).toBe("showArrivals");
    expect(decide("Enter", "list")).toBe("activate");
    expect(decideInboxKeyAction(press("["), "list")).toEqual({ kind: "stepAsk", by: -1 });
    expect(decideInboxKeyAction(press("]"), "list")).toEqual({ kind: "stepAsk", by: 1 });
    expect(decideInboxKeyAction(press(" "), "list")).toEqual({ kind: "scrollPane", back: false });
    expect(decideInboxKeyAction(press(" ", { shiftKey: true }), "list")).toEqual({
      kind: "scrollPane",
      back: true,
    });
    expect(decideInboxKeyAction(press("3"), "list")).toEqual({ kind: "pickList", index: 2 });
    expect(decide("a", "list", { metaKey: true })).toBe("selectAll");
  });

  it("does nothing for a digit past 7, for other letters and for a modifier on a letter", () => {
    expect(decide("8", "list")).toBeNull();
    expect(decide("z", "list")).toBeNull();
    expect(decide("e", "list", { metaKey: true })).toBeNull();
    expect(decide("e", "list", { altKey: true })).toBeNull();
  });

  it("acts on single keys only in the list, so the rail, the bar, menus and fields never move a row", () => {
    for (const place of ["rail", "bar", "overlay", "field", "outside"] as const) {
      expect(decide("e", place)).toBeNull();
      expect(decide("j", place)).toBeNull();
    }
  });

  it("lets the digits pick a list from the rail, and nothing else there", () => {
    expect(decideInboxKeyAction(press("2"), "rail")).toEqual({ kind: "pickList", index: 1 });
    expect(decide("2", "bar")).toBeNull();
  });

  it("reaches the search and the keys from the rail and the bar, but not from a field or a menu", () => {
    expect(decide("/", "rail")).toBe("search");
    expect(decide("?", "bar")).toBe("toggleKeys");
    expect(decide("/", "field")).toBeNull();
    expect(decide("?", "overlay")).toBeNull();
  });

  it("steps back from the list on Esc, and brings the focus back to the list from anywhere else", () => {
    expect(decide("Escape", "list")).toBe("stepBack");
    expect(decide("Escape", "rail")).toBe("focusList");
    expect(decide("Escape", "bar")).toBe("focusList");
    expect(decide("Escape", "field")).toBeNull();
  });

  it("leaves Return and Space to a focused button", () => {
    expect(decide("Enter", "list", { isOnControl: true })).toBeNull();
    expect(decide(" ", "list", { isOnControl: true })).toBeNull();
    expect(decide("j", "list", { isOnControl: true })).toBe("step");
  });

  it("never repeats a move while a key is held, but walks while J is held", () => {
    expect(decide("e", "list", { repeat: true })).toBeNull();
    // Holding Return must not answer one thing after another.
    expect(decide("Enter", "list", { repeat: true })).toBeNull();
    expect(decide("Enter", "list")).toBe("activate");
    expect(decide("j", "list", { repeat: true })).toBe("step");
  });

  it("moves between the regions with F6 from everywhere in the Inbox, backwards with Shift", () => {
    expect(decideInboxKeyAction(press("F6", { shiftKey: true }), "field")).toEqual({
      kind: "nextRegion",
      backwards: true,
    });
    expect(decide("F6", "outside")).toBeNull();
  });
});

describe("readInboxKeyPlace", () => {
  afterEach(cleanup);

  it("tells the list, the pane and the empty state from the rail, the bar and the rest of the app", () => {
    const { baseElement } = render(
      <>
        <div className="ib">
          <div id="inbox-rail">
            <button id="rail">Mine</button>
          </div>
          <div className="ib-bar">
            <button id="bar">?</button>
            <input id="field" />
          </div>
          <div className="ib-rows">
            <div id="row" tabIndex={0} />
          </div>
          <div className="ib-empty">
            <h2 id="heading" tabIndex={-1}>
              All clear
            </h2>
          </div>
          <aside id="inbox-pane">
            <button id="pane">Take on</button>
          </aside>
          <div popover="auto" id="menu">
            <button id="pick">Pick</button>
          </div>
        </div>
        <nav>
          <button id="sidebar">Work</button>
        </nav>
      </>,
    );
    const at = (id: string): InboxKeyPlace =>
      readInboxKeyPlace(baseElement.ownerDocument.getElementById(id));
    expect(at("row")).toBe("list");
    expect(at("heading")).toBe("list");
    expect(at("pane")).toBe("list");
    expect(at("rail")).toBe("rail");
    expect(at("bar")).toBe("bar");
    expect(at("field")).toBe("field");
    expect(at("pick")).toBe("overlay");
    expect(at("sidebar")).toBe("outside");
    expect(readInboxKeyPlace(document.body)).toBe("list");
  });
});
