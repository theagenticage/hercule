/** Checks over a whole event stream, shared by the tests that play recordings. */
import { expect } from "vitest";
import type { HarnessEvent } from "@hercule/protocol";

/**
 * Checks that an event stream holds together as a whole, whichever way it was
 * produced: every item starts once and completes once, no delta follows its
 * item's end, only a todo list is ever updated, turns open and close one at a
 * time, and no item is of an unknown kind. Fails the calling test otherwise.
 */
export const expectEventStreamToHoldTogether = (events: ReadonlyArray<HarnessEvent>): void => {
  const started = events.filter((event) => event._tag === "item.started");
  const completed = events.filter((event) => event._tag === "item.completed");
  const startedIds = started.map((event) => event.itemId);
  expect(new Set(startedIds).size, "item ids are unique").toBe(startedIds.length);
  for (const id of startedIds) {
    expect(
      completed.filter((event) => event.itemId === id).length,
      `item ${id} completes once`,
    ).toBe(1);
  }

  const completedAt = new Map<string, number>();
  events.forEach((event, index) => {
    if (event._tag === "item.completed") completedAt.set(event.itemId, index);
    if (event._tag === "item.updated") expect(event.kind).toBe("todo_list");
  });
  events.forEach((event, index) => {
    if (event._tag === "content.delta") {
      const end = completedAt.get(event.itemId);
      expect(end === undefined || index < end, `delta of ${event.itemId} after its end`).toBe(true);
    }
  });

  let open: string | undefined;
  for (const event of events) {
    if (event._tag === "turn.started") {
      expect(open, "no second turn opens").toBeUndefined();
      open = event.turnId;
    } else if (event._tag === "turn.completed") {
      expect(event.turnId).toBe(open);
      open = undefined;
    }
  }
  expect(open, "the last turn completes").toBeUndefined();

  expect(
    started.filter((event) => event.kind === "unknown"),
    "no unknown item",
  ).toEqual([]);
};
