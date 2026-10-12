/**
 * Tests the record behind Intake's To do as shown: which changes wait while
 * the pointer is over the list, and when inbox zero arrives.
 */
import { describe, expect, it } from "vitest";
import type { Signal } from "@hercule/contract";
import {
  followToDo,
  holdChanges,
  registerOwnChanges,
  releaseChanges,
  startHeldToDo,
} from "./use-held-to-do";

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

describe("followToDo", () => {
  it("shows every read as it is while nothing is held", () => {
    const held = followToDo(startHeldToDo([A, B], "to-do:all"), [B, C]);
    expect(readIds(held.shown)).toEqual(["b", "c"]);
    expect(held.arriving).toBe(false);
  });

  it("arrives at inbox zero when the user's own action takes the last signals off", () => {
    let held = startHeldToDo([A, B], "to-do:all");
    held = registerOwnChanges(held, ["a", "b"]);
    held = followToDo(held, []);
    expect(held.arriving).toBe(true);
    expect(held.own.size).toBe(0);
  });

  it("does not arrive when a signal left through a change the user did not make", () => {
    let held = startHeldToDo([A, B], "to-do:all");
    held = registerOwnChanges(held, ["a"]);
    held = followToDo(held, []);
    expect(held.shown).toEqual([]);
    expect(held.arriving).toBe(false);
  });

  it("keeps the arrival while later reads find To do still empty, and ends it when a signal comes", () => {
    let held = followToDo(registerOwnChanges(startHeldToDo([A], "to-do:all"), ["a"]), []);
    held = followToDo(held, []);
    expect(held.arriving).toBe(true);
    held = followToDo(held, [B]);
    expect(held.arriving).toBe(false);
  });

  it("keeps an own change until a read shows it", () => {
    let held = registerOwnChanges(startHeldToDo([A, B], "to-do:all"), ["a"]);
    held = followToDo(held, [A, B, C]);
    expect([...held.own.keys()]).toEqual(["a"]);
    held = followToDo(held, [buildSignal("a", "Answered"), B, C]);
    expect(held.own.size).toBe(0);
  });
});

describe("holding", () => {
  it("holds back changes the user did not make, and applies the user's own at once", () => {
    let held = holdChanges(startHeldToDo([A, B], "to-do:all"));
    held = registerOwnChanges(held, ["a"]);
    held = followToDo(held, [B, C]);
    expect(readIds(held.shown)).toEqual(["b"]);
  });

  it("applies a held change to a row the user changed, as the read has it", () => {
    let held = holdChanges(startHeldToDo([A, B], "to-do:all"));
    held = registerOwnChanges(held, ["b"]);
    const answered = buildSignal("b", "Answered");
    held = followToDo(held, [answered]);
    expect(held.shown).toEqual([A, answered]);
  });

  it("applies everything held in one step once the pointer leaves", () => {
    let held = holdChanges(startHeldToDo([A], "to-do:all"));
    held = followToDo(held, [A, B]);
    held = followToDo(held, [A, B, C]);
    expect(readIds(held.shown)).toEqual(["a"]);
    held = releaseChanges(held);
    expect(readIds(held.shown)).toEqual(["a", "b", "c"]);
  });

  it("shows inbox zero still when the release empties the list", () => {
    let held = holdChanges(startHeldToDo([A], "to-do:all"));
    held = followToDo(held, []);
    expect(readIds(held.shown)).toEqual(["a"]);
    held = releaseChanges(held);
    expect(held.shown).toEqual([]);
    expect(held.arriving).toBe(false);
  });
});
