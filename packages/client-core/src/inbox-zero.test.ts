import { describe, expect, it } from "vitest";
import { describeInboxZero } from "./inbox-zero";

// Kolkata has no daylight saving time and a half-hour offset, so every
// boundary lands on :30 UTC, where a machine-zone bug cannot land.
const KOLKATA = "Asia/Kolkata";

/** Returns the instant the clock in Kolkata reads `local` (`YYYY-MM-DDTHH:MM`). */
const atKolkata = (local: string): Date => new Date(`${local}:00+05:30`);

describe("describeInboxZero", () => {
  // 12 October 2026 is a Monday; 16 October a Friday.
  it.each([
    ["2026-10-12T00:00", "The rest of the morning is yours.", "2026-10-12T12:00"],
    ["2026-10-12T11:59", "The rest of the morning is yours.", "2026-10-12T12:00"],
    ["2026-10-12T12:00", "The rest of the afternoon is yours.", "2026-10-12T18:00"],
    ["2026-10-12T17:59", "The rest of the afternoon is yours.", "2026-10-12T18:00"],
    ["2026-10-12T18:00", "Go home.", "2026-10-13T00:00"],
    ["2026-10-12T23:59", "Go home.", "2026-10-13T00:00"],
    ["2026-10-16T11:59", "The rest of the morning is yours.", "2026-10-16T12:00"],
    ["2026-10-16T12:00", "Have a good weekend.", "2026-10-16T18:00"],
    ["2026-10-16T18:00", "Have a good weekend.", "2026-10-17T00:00"],
    ["2026-10-17T00:00", "Nothing needs you this weekend.", "2026-10-17T12:00"],
    ["2026-10-17T19:00", "Nothing needs you this weekend.", "2026-10-18T00:00"],
    ["2026-10-18T09:00", "Nothing needs you this weekend.", "2026-10-18T12:00"],
    ["2026-10-19T00:00", "The rest of the morning is yours.", "2026-10-19T12:00"],
  ])("at %s reads %j until %s", (now, text, changesAt) => {
    expect(describeInboxZero(atKolkata(now), KOLKATA)).toEqual({
      text,
      changesAt: atKolkata(changesAt),
    });
  });

  it("reads the line in the given zone, not the machine's", () => {
    // 20:00 UTC on Friday is already Saturday 01:30 in Kolkata.
    expect(describeInboxZero(new Date("2026-10-16T20:00:00Z"), KOLKATA).text).toBe(
      "Nothing needs you this weekend.",
    );
  });
});
