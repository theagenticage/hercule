import { describe, expect, it } from "vitest";
import { buildQueryKeys, queryKeys } from "../live/keys";
import { buildWorkBoardKey } from "./board-key";

/** Checks that `key` starts with all of `prefix`, the way a query invalidation matches. */
const startsWith = (key: ReadonlyArray<unknown>, prefix: ReadonlyArray<unknown>): boolean =>
  prefix.every((part, index) => key[index] === part);

describe("the Work board's query key", () => {
  it("starts with the Tasks' key, so a task push reads the board again", () => {
    const [tasksKey] = buildQueryKeys("task", ["task-1"]);

    expect(tasksKey).toEqual(queryKeys.tasks());
    expect(buildWorkBoardKey().slice(0, tasksKey!.length)).toEqual(tasksKey);
  });

  it("differs from the key of the list of Tasks", () => {
    expect(buildWorkBoardKey()).not.toEqual(queryKeys.tasks());
  });

  it("is the only read of a derived task push, which leaves Tracking and Your work alone", () => {
    for (const ids of [[], ["task-1"]]) {
      const keys = buildQueryKeys("task", ids, undefined, true);

      expect(keys).toEqual([buildWorkBoardKey()]);
      expect(keys.some((key) => startsWith(key, queryKeys.tracking()))).toBe(false);
      expect(keys.some((key) => startsWith(key, queryKeys.yourWork()))).toBe(false);
    }
  });

  it("is read with Tracking and Your work by an ordinary task push", () => {
    const keys = buildQueryKeys("task", ["task-1"]);

    for (const read of [buildWorkBoardKey(), queryKeys.tracking(), queryKeys.yourWork()]) {
      expect(keys.some((key) => startsWith(read, key))).toBe(true);
    }
  });
});
