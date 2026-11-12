/** Tests that the board snapshot read back from `localStorage` is trusted only when every part of it is what it should be. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "@hercule/client-core/work";
import {
  buildBoardSnapshotKey,
  readSavedBoardSnapshot,
  writeSavedBoardSnapshot,
} from "./board-snapshot-storage";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const KEY = buildBoardSnapshotKey("http://controller.test", "noa");

const SNAPSHOT: BoardSnapshot = {
  cards: [
    { id: "a", stage: "in-review", projectId: "depots" },
    {
      id: "b",
      stage: "landed",
      stageCause: {
        kind: "fact",
        factId: 4,
        ref: "github:pull-request:6221",
        text: "Pull request #6221 merged",
      },
    },
  ],
  isTruncated: false,
};

/** Stores `value` as the text under the key, as an earlier version of the app or a broken write might have. */
const store = (value: unknown): void => {
  localStorage.setItem(KEY, typeof value === "string" ? value : JSON.stringify(value));
};

describe("the saved board snapshot", () => {
  it("reads as none when nothing is stored", () => {
    expect(readSavedBoardSnapshot(KEY)).toBeUndefined();
  });

  it("returns what was written", () => {
    writeSavedBoardSnapshot(KEY, SNAPSHOT);

    expect(readSavedBoardSnapshot(KEY)).toEqual(SNAPSHOT);
  });

  it("keeps each user's snapshot apart", () => {
    writeSavedBoardSnapshot(KEY, SNAPSHOT);

    expect(
      readSavedBoardSnapshot(buildBoardSnapshotKey("http://controller.test", "river")),
    ).toBeUndefined();
    expect(
      readSavedBoardSnapshot(buildBoardSnapshotKey("http://other.test", "noa")),
    ).toBeUndefined();
  });

  it.each([
    ["text that is not JSON", "{nope"],
    ["JSON that is not an object", "[1, 2]"],
    ["an object with no cards", { isTruncated: false }],
    ["cards that are not a list", { cards: "a", isTruncated: false }],
  ])("reads %s as none", (_, stored) => {
    store(stored);

    expect(readSavedBoardSnapshot(KEY)).toBeUndefined();
  });

  it.each([
    ["a card with no id", { stage: "landed" }],
    ["a card with a stage the board does not have", { id: "a", stage: "done" }],
    ["a card whose Project is not text", { id: "a", stage: "landed", projectId: 7 }],
    [
      "a cause with no fact id (a snapshot of the earlier shape)",
      { id: "a", stage: "landed", stageCause: { ref: "github:pull-request:6221", text: "merged" } },
    ],
    [
      "a cause whose fact id is not a whole number",
      {
        id: "a",
        stage: "landed",
        stageCause: { factId: 1.5, ref: "github:pull-request:6221", text: "merged" },
      },
    ],
    ["a cause that is not an object", { id: "a", stage: "landed", stageCause: "merged" }],
  ])("reads the whole snapshot as none for %s, so no card shows as new by mistake", (_, card) => {
    store({ cards: [SNAPSHOT.cards[0], card], isTruncated: false });

    expect(readSavedBoardSnapshot(KEY)).toBeUndefined();
  });

  it("reads a cause stored without a kind, written before reports existed, as a fact", () => {
    store({
      cards: [
        {
          id: "b",
          stage: "landed",
          stageCause: { factId: 4, ref: "github:pull-request:6221", text: "merged" },
        },
      ],
      isTruncated: false,
    });

    expect(readSavedBoardSnapshot(KEY)?.cards).toEqual([
      {
        id: "b",
        stage: "landed",
        stageCause: { kind: "fact", factId: 4, ref: "github:pull-request:6221", text: "merged" },
      },
    ]);
  });

  it("reads and keeps a cause that is a report", () => {
    const report = {
      kind: "report",
      sessionId: "s1",
      stageRevision: 3,
      text: "“Pricing research” says Planned",
    };
    store({ cards: [{ id: "b", stage: "planned", stageCause: report }], isTruncated: false });

    expect(readSavedBoardSnapshot(KEY)?.cards).toEqual([
      { id: "b", stage: "planned", stageCause: report },
    ]);
  });

  it("reads the whole snapshot as none for a report with no stage revision", () => {
    store({
      cards: [
        {
          id: "b",
          stage: "planned",
          stageCause: { kind: "report", sessionId: "s1", text: "says Planned" },
        },
      ],
      isTruncated: false,
    });

    expect(readSavedBoardSnapshot(KEY)).toBeUndefined();
  });

  it("reads the whole snapshot as none for a report with no session", () => {
    store({
      cards: [{ id: "b", stage: "planned", stageCause: { kind: "report", text: "says Planned" } }],
      isTruncated: false,
    });

    expect(readSavedBoardSnapshot(KEY)).toBeUndefined();
  });

  it("reads a missing or odd truncation flag as a whole board", () => {
    store({ cards: SNAPSHOT.cards });
    expect(readSavedBoardSnapshot(KEY)?.isTruncated).toBe(false);

    store({ cards: SNAPSHOT.cards, isTruncated: "yes" });
    expect(readSavedBoardSnapshot(KEY)?.isTruncated).toBe(false);

    store({ cards: SNAPSHOT.cards, isTruncated: true });
    expect(readSavedBoardSnapshot(KEY)?.isTruncated).toBe(true);
  });

  it("keeps working when the storage refuses a write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("The storage is full.");
    });

    expect(() => {
      writeSavedBoardSnapshot(KEY, SNAPSHOT);
    }).not.toThrow();
  });
});
