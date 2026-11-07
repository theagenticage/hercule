import { describe, expect, it } from "vitest";
import { buildQueryKeys, queryKeys } from "../live/keys";
import { buildWorkBoardKey } from "./board-key";

describe("the Work board's query key", () => {
  it("starts with the Tasks' key, so a task push reads the board again", () => {
    const [tasksKey] = buildQueryKeys("task", ["task-1"]);

    expect(tasksKey).toEqual(queryKeys.tasks());
    expect(buildWorkBoardKey().slice(0, tasksKey!.length)).toEqual(tasksKey);
  });

  it("differs from the key of the list of Tasks", () => {
    expect(buildWorkBoardKey()).not.toEqual(queryKeys.tasks());
  });
});
