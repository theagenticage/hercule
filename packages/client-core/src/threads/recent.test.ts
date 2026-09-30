/**
 * Tests `pushRecent(recent, pair)`, which keeps the last three (instance,
 * model) pairs the user picked, newest first; `buildRecentModel`, which
 * decides which pair a successful submission adds; and `parseRecentModels`,
 * which reads that list back from the JSON text a client stored.
 */
import { describe, expect, it } from "vitest";
import { buildRecentModel, parseRecentModels, pushRecent } from "./recent";

const WORK = "instance-claude-work";
const PERSONAL = "instance-claude-personal";
const SONNET = "claude-sonnet-5";
const OPUS = "claude-opus-5";
const HAIKU = "claude-haiku-5";

describe("buildRecentModel", () => {
  it("adds the model the user picked, with the thread's account", () => {
    expect(buildRecentModel({ model: OPUS, options: { effort: "high" } }, WORK)).toEqual({
      instanceId: WORK,
      model: OPUS,
    });
  });

  it("adds nothing when the user picked no model, since Recent never holds a default", () => {
    expect(buildRecentModel({}, WORK)).toBeNull();
    expect(buildRecentModel({ model: null }, WORK)).toBeNull();
    expect(buildRecentModel({ options: { effort: "high" } }, WORK)).toBeNull();
  });

  it("adds nothing for a thread with no account", () => {
    expect(buildRecentModel({ model: OPUS }, null)).toBeNull();
  });
});

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

describe("parseRecentModels", () => {
  it("reads the stored pairs in their order", () => {
    const stored = JSON.stringify([
      { instanceId: WORK, model: OPUS },
      { instanceId: PERSONAL, model: SONNET },
    ]);
    expect(parseRecentModels(stored)).toEqual([
      { instanceId: WORK, model: OPUS },
      { instanceId: PERSONAL, model: SONNET },
    ]);
  });

  it("reads nothing stored as an empty list", () => {
    expect(parseRecentModels(null)).toEqual([]);
  });

  it("reads text that is not JSON as an empty list", () => {
    expect(parseRecentModels("[{instanceId")).toEqual([]);
  });

  it("reads JSON that is not a list of pairs as an empty list", () => {
    expect(parseRecentModels(JSON.stringify({ instanceId: WORK, model: OPUS }))).toEqual([]);
    expect(parseRecentModels(JSON.stringify([{ instanceId: WORK }]))).toEqual([]);
    expect(parseRecentModels(JSON.stringify([{ instanceId: WORK, model: 3 }]))).toEqual([]);
  });

  it("keeps only the three newest pairs of a longer stored list", () => {
    const stored = JSON.stringify([
      { instanceId: WORK, model: OPUS },
      { instanceId: WORK, model: SONNET },
      { instanceId: WORK, model: HAIKU },
      { instanceId: PERSONAL, model: OPUS },
    ]);
    expect(parseRecentModels(stored)).toEqual([
      { instanceId: WORK, model: OPUS },
      { instanceId: WORK, model: SONNET },
      { instanceId: WORK, model: HAIKU },
    ]);
  });
});
