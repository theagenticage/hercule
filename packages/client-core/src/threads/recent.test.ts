/**
 * Tests `pushRecent(recent, pair)`, which keeps the last three (instance,
 * model) pairs the user picked, newest first.
 */
import { describe, expect, it } from "vitest";
import { pushRecent } from "./recent";

const WORK = "instance-claude-work";
const PERSONAL = "instance-claude-personal";
const SONNET = "claude-sonnet-5";
const OPUS = "claude-opus-5";
const HAIKU = "claude-haiku-5";

describe("pushRecent", () => {
  it("starts the list with the first pick", () => {
    expect(pushRecent([], { instanceId: WORK, model: SONNET })).toEqual([
      { instanceId: WORK, model: SONNET },
    ]);
  });

  it("puts the newest pair first", () => {
    expect(
      pushRecent([{ instanceId: WORK, model: SONNET }], { instanceId: WORK, model: OPUS }),
    ).toEqual([
      { instanceId: WORK, model: OPUS },
      { instanceId: WORK, model: SONNET },
    ]);
  });

  it("moves a pair that is already in the list to the front rather than adding it twice", () => {
    expect(
      pushRecent(
        [
          { instanceId: WORK, model: SONNET },
          { instanceId: WORK, model: OPUS },
        ],
        { instanceId: WORK, model: OPUS },
      ),
    ).toEqual([
      { instanceId: WORK, model: OPUS },
      { instanceId: WORK, model: SONNET },
    ]);
  });

  it("treats the same model on another instance as another pair", () => {
    expect(
      pushRecent([{ instanceId: WORK, model: SONNET }], { instanceId: PERSONAL, model: SONNET }),
    ).toEqual([
      { instanceId: PERSONAL, model: SONNET },
      { instanceId: WORK, model: SONNET },
    ]);
  });

  it("caps the list at three, dropping the oldest", () => {
    expect(
      pushRecent(
        [
          { instanceId: WORK, model: SONNET },
          { instanceId: WORK, model: OPUS },
          { instanceId: WORK, model: HAIKU },
        ],
        { instanceId: PERSONAL, model: SONNET },
      ),
    ).toEqual([
      { instanceId: PERSONAL, model: SONNET },
      { instanceId: WORK, model: SONNET },
      { instanceId: WORK, model: OPUS },
    ]);
  });
});
