/**
 * Tests how a Task's links count: one row for each case of the rules in
 * `countLinkedWork`, in the order the rules list them.
 */
import { describe, expect, it } from "vitest";
import type { EntityLifecycle } from "@hercule/contract";
import type { LinkedEntityState } from "./linked-entities";
import { countLinkedWork } from "./linked-work";

/** A readable, full record of a pull request. */
const work = (
  lifecycle: EntityLifecycle,
  overrides: Partial<LinkedEntityState> = {},
): LinkedEntityState => ({
  kind: "github/pull-request",
  classification: "work",
  isFullRecord: true,
  lifecycle,
  isReadable: true,
  ...overrides,
});

describe("countLinkedWork", () => {
  it.each<[string, ReadonlyArray<LinkedEntityState | undefined>, [number, number]]>([
    ["a ref nothing is known of is neither", [undefined], [0, 0]],
    [
      "a link to a context kind is neither",
      [work("open", { classification: "context", kind: "github/repository" })],
      [0, 0],
    ],
    [
      "work with no record is open",
      [work("open", { isFullRecord: false, lifecycle: null, isReadable: false })],
      [1, 0],
    ],
    [
      "a partial record is open, whatever it says",
      [work("completed", { isFullRecord: false })],
      [1, 0],
    ],
    ["work with no known lifecycle is open", [work("open", { lifecycle: null })], [1, 0]],
    ["work nobody can read is open", [work("open", { isReadable: false })], [1, 0]],
    [
      "completed work nobody can read is open, not completed",
      [work("completed", { isReadable: false })],
      [1, 0],
    ],
    ["readable open work is open", [work("open")], [1, 0]],
    ["readable completed work is completed", [work("completed")], [0, 1]],
    ["readable abandoned work is neither", [work("abandoned")], [0, 0]],
    [
      "completed and abandoned work leaves one completed link and nothing open",
      [work("completed"), work("abandoned")],
      [0, 1],
    ],
    ["all links abandoned counts nothing", [work("abandoned"), work("abandoned")], [0, 0]],
    [
      "one open link keeps two completed ones from finishing the Task",
      [work("completed"), work("completed"), work("open")],
      [1, 2],
    ],
    [
      "a context link beside completed work changes nothing",
      [work("completed"), undefined],
      [0, 1],
    ],
    ["a Task with no links counts nothing", [], [0, 0]],
  ])("%s", (_name, states, [openLinks, completedLinks]) => {
    expect(countLinkedWork(states)).toEqual({ openLinks, completedLinks });
  });
});
