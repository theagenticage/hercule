/**
 * Tests the record behind the signals Intake's list shows: which changes
 * wait while the pointer is over the list, and when inbox zero arrives.
 */
import { describe, expect, it } from "vitest";
import type { Signal } from "@hercule/contract";
import {
  dropOwnChanges,
  followListedSignals,
  recordOwnChanges,
  startHeldSignals,
  switchHeldScope,
  updateHolding,
} from "./held-signals";

/** Builds an open signal with id `id`; `title` tells two versions of one row apart. */
const buildSignal = (id: string, title = `Signal ${id}`): Signal => ({
  id,
  kind: "github/review-requested",
  origin: { type: "api", actor: "user", eventIds: [], reason: "Test" },
  title,
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: "2026-10-10T09:00:00.000Z",
});

const A = buildSignal("a");
const B = buildSignal("b");
const C = buildSignal("c");

const readIds = (signals: ReadonlyArray<Signal>) => signals.map((signal) => signal.id);

describe("followListedSignals", () => {
  it("shows every read as it is while nothing is held", () => {
    const held = followListedSignals(startHeldSignals([A, B], "to-do:all"), [B, C]);
    expect(readIds(held.shown)).toEqual(["b", "c"]);
    expect(held.arriving).toBe(false);
  });

  it("arrives at inbox zero when the user's own action takes the last signals off", () => {
    let held = startHeldSignals([A, B], "to-do:all");
    held = recordOwnChanges(held, ["a", "b"]);
    held = followListedSignals(held, []);
    expect(held.arriving).toBe(true);
    expect(held.ownChanges.size).toBe(0);
  });

  it("does not arrive when a signal left through a change the user did not make", () => {
    let held = startHeldSignals([A, B], "to-do:all");
    held = recordOwnChanges(held, ["a"]);
    held = followListedSignals(held, []);
    expect(held.shown).toEqual([]);
    expect(held.arriving).toBe(false);
  });

  it("keeps the arrival while later reads find the list still empty, and ends it when a signal comes", () => {
    let held = followListedSignals(recordOwnChanges(startHeldSignals([A], "to-do:all"), ["a"]), []);
    held = followListedSignals(held, []);
    expect(held.arriving).toBe(true);
    held = followListedSignals(held, [B]);
    expect(held.arriving).toBe(false);
  });

  it("keeps an own change until a read shows it", () => {
    let held = recordOwnChanges(startHeldSignals([A, B], "to-do:all"), ["a"]);
    held = followListedSignals(held, [A, B, C]);
    expect([...held.ownChanges.keys()]).toEqual(["a"]);
    held = followListedSignals(held, [buildSignal("a", "Answered"), B, C]);
    expect(held.ownChanges.size).toBe(0);
  });
});

describe("recordOwnChanges", () => {
  it("leaves out a signal the list does not hold, so no read can hold it forever", () => {
    const held = startHeldSignals([A], "to-do:all");
    expect(recordOwnChanges(held, ["z"])).toBe(held);
    expect([...recordOwnChanges(held, ["a", "z"]).ownChanges.keys()]).toEqual(["a"]);
  });
});

describe("holding", () => {
  it("holds back changes the user did not make, and applies the user's own at once", () => {
    let held = updateHolding(startHeldSignals([A, B], "to-do:all"), true);
    held = recordOwnChanges(held, ["a"]);
    held = followListedSignals(held, [C, B]);
    expect(readIds(held.shown)).toEqual(["b"]);
  });

  it("applies the user's own change when the controller's read comes before the action's answer", () => {
    // The move records as it starts; the push's read lands while the move
    // still waits for its answer.
    let held = updateHolding(startHeldSignals([A, B], "to-do:all"), true);
    held = recordOwnChanges(held, ["a", "b"]);
    held = followListedSignals(held, []);
    expect(held.shown).toEqual([]);
    expect(held.arriving).toBe(true);
  });

  it("holds back a change to a signal whose own change was dropped", () => {
    let held = updateHolding(startHeldSignals([A, B], "to-do:all"), true);
    held = recordOwnChanges(held, ["a", "b"]);
    held = dropOwnChanges(held, ["b"]);
    held = followListedSignals(held, []);
    expect(readIds(held.shown)).toEqual(["b"]);
    expect(held.arriving).toBe(false);
  });

  it("holds back a change to a shown row, even when the order stays", () => {
    // A lower priority can move the row to another section without moving it in the list.
    let held = updateHolding(startHeldSignals([A, B], "to-do:all"), true);
    held = followListedSignals(held, [buildSignal("a", "Lowered"), B]);
    expect(held.shown).toEqual([A, B]);
  });

  it("holds back a row added after the shown ones", () => {
    let held = updateHolding(startHeldSignals([A], "to-do:all"), true);
    held = followListedSignals(held, [A, B]);
    expect(held.shown).toEqual([A]);
  });

  it("holds back the first row of an empty list, which would take the place of inbox zero", () => {
    let held = updateHolding(startHeldSignals([], "to-do:all"), true);
    held = followListedSignals(held, [A]);
    expect(held.shown).toEqual([]);
  });

  it("moves a row the user changed to where the read puts it", () => {
    // Later: A and B on Tuesday, C on Wednesday. The user snoozes A to Wednesday, before C.
    let held = updateHolding(startHeldSignals([A, B, C], "later:all"), true);
    held = recordOwnChanges(held, ["a"]);
    const snoozed = buildSignal("a", "Wednesday");
    held = followListedSignals(held, [B, snoozed, C]);
    expect(held.shown).toEqual([B, snoozed, C]);
  });

  it("shows the read whole when the user's own change keeps the row in the list", () => {
    // Held: B was snoozed elsewhere to a later day. The user's own snooze of
    // A shows that too, so no row sits among rows of another day.
    let held = updateHolding(startHeldSignals([A, B, C], "later:all"), true);
    const movedElsewhere = buildSignal("b", "Thursday");
    held = followListedSignals(held, [A, C, movedElsewhere]);
    expect(held.shown).toEqual([A, B, C]);
    held = recordOwnChanges(held, ["a"]);
    const snoozed = buildSignal("a", "Thursday");
    held = followListedSignals(held, [C, movedElsewhere, snoozed]);
    expect(held.shown).toEqual([C, movedElsewhere, snoozed]);
  });

  it("applies everything held in one step once the pointer leaves", () => {
    let held = updateHolding(startHeldSignals([B], "to-do:all"), true);
    held = followListedSignals(held, [A, B]);
    held = followListedSignals(held, [A, B, C]);
    expect(readIds(held.shown)).toEqual(["b"]);
    held = updateHolding(held, false);
    expect(readIds(held.shown)).toEqual(["a", "b", "c"]);
  });

  it("shows inbox zero still when the release empties the list", () => {
    let held = updateHolding(startHeldSignals([A], "to-do:all"), true);
    held = followListedSignals(held, []);
    expect(readIds(held.shown)).toEqual(["a"]);
    held = updateHolding(held, false);
    expect(held.shown).toEqual([]);
    expect(held.arriving).toBe(false);
  });

  it("returns the same record when holding does not change", () => {
    const held = startHeldSignals([A], "to-do:all");
    expect(updateHolding(held, false)).toBe(held);
  });
});

describe("switchHeldScope", () => {
  it("shows the new list and stops an arrival", () => {
    let held = recordOwnChanges(startHeldSignals([A], "to-do:all"), ["a"]);
    held = followListedSignals(held, []);
    expect(held.arriving).toBe(true);
    held = updateHolding(held, true);
    held = switchHeldScope(held, [B], "done:all");
    expect(held.shown).toEqual([B]);
    expect(held.arriving).toBe(false);
    expect(held.holding).toBe(true);
  });

  it("keeps an own change that waits for its answer while a new page loads", () => {
    let held = updateHolding(startHeldSignals([A, B], "later:all:1"), true);
    held = recordOwnChanges(held, ["a"]);
    held = switchHeldScope(held, [A, B, C], "later:all:2");
    held = followListedSignals(held, [B, C]);
    expect(held.shown).toEqual([B, C]);
  });

  it("forgets an own change the new list already shows, so a later change elsewhere waits", () => {
    let held = updateHolding(startHeldSignals([A, B], "later:all:1"), true);
    held = recordOwnChanges(held, ["a"]);
    const snoozed = buildSignal("a", "Friday");
    held = switchHeldScope(held, [snoozed, B], "later:all:2");
    expect(held.ownChanges.size).toBe(0);
    held = followListedSignals(held, [buildSignal("a", "Saturday"), B]);
    expect(held.shown).toEqual([snoozed, B]);
  });
});
