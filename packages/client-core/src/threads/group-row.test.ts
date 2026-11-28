import { describe, expect, it } from "vitest";
import { buildRowSecondLine } from "./group-row";

const PLACE = { clip: "studio-mac", keep: "" };
const ACTIVITY_AT = "2026-11-19T09:00:00.000Z";

describe("buildRowSecondLine", () => {
  it("starts a working row's line with its state, then where it works, and leaves the age out", () => {
    expect(
      buildRowSecondLine({
        status: "working",
        activityAt: ACTIVITY_AT,
        ask: null,
        placeLabel: PLACE,
      }),
    ).toEqual([
      { kind: "state", state: "working", word: "Working" },
      { kind: "place", label: PLACE },
    ]);
  });

  it("starts a waiting row's line with its state, then the question in place of where it works", () => {
    const ask = { askerLabel: null, question: "Keep the old Grafana folder?" };
    expect(
      buildRowSecondLine({ status: "question", activityAt: ACTIVITY_AT, ask, placeLabel: PLACE }),
    ).toEqual([
      { kind: "state", state: "question", word: "Question" },
      { kind: "ask", ask },
    ]);
    expect(
      buildRowSecondLine({
        status: "approval",
        activityAt: ACTIVITY_AT,
        ask,
        placeLabel: PLACE,
      })[0],
    ).toEqual({ kind: "state", state: "approval", word: "Approval" });
  });

  it("names a queued or offline row's state in words", () => {
    for (const [state, word] of [
      ["queued", "Queued"],
      ["offline", "Offline"],
    ] as const) {
      expect(
        buildRowSecondLine({
          status: state,
          activityAt: ACTIVITY_AT,
          ask: null,
          placeLabel: PLACE,
        }),
      ).toEqual([
        { kind: "state", state, word },
        { kind: "place", label: PLACE },
      ]);
    }
  });

  it("ends a row with no state with its age, after where it works", () => {
    expect(
      buildRowSecondLine({ status: "age", activityAt: ACTIVITY_AT, ask: null, placeLabel: PLACE }),
    ).toEqual([
      { kind: "place", label: PLACE },
      { kind: "age", at: ACTIVITY_AT },
    ]);
  });
});
