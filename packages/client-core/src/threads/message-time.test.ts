/**
 * Tests `formatMessageTime(instant, timezone, now)`, which formats the time
 * under a message in the desktop thread, and the two lines that hold such a
 * time: an agent message's meta line and the note that the thread waits on
 * the user.
 */
import { describe, expect, it } from "vitest";
import { describeMessageMeta, describeWaitingNote, formatMessageTime } from "./message-time";

const NOW = new Date("2026-09-30T12:00:00.000Z");

describe("formatMessageTime", () => {
  it("shows only the time for a message sent today", () => {
    expect(formatMessageTime(new Date("2026-09-30T09:04:59.000Z"), "UTC", NOW)).toBe("09:04");
  });

  it("shows the day and the time for a message sent on another day", () => {
    expect(formatMessageTime(new Date("2026-09-04T09:04:00.000Z"), "UTC", NOW)).toBe("4 Sep 09:04");
  });

  it("shows the day for a message sent on the same date a year ago", () => {
    expect(formatMessageTime(new Date("2025-09-30T09:04:00.000Z"), "UTC", NOW)).toBe(
      "30 Sep 09:04",
    );
  });

  it("decides the day in the given time zone", () => {
    // 23:30 UTC on 30 September is 01:30 on 1 October in Amsterdam.
    const instant = new Date("2026-09-30T23:30:00.000Z");

    expect(formatMessageTime(instant, "UTC", NOW)).toBe("23:30");
    expect(formatMessageTime(instant, "Europe/Amsterdam", NOW)).toBe("1 Oct 01:30");
  });

  it("returns undefined for a zone this runtime cannot format", () => {
    expect(formatMessageTime(NOW, "Not/AZone", NOW)).toBeUndefined();
  });
});

describe("describeMessageMeta", () => {
  it("puts the time after the agent", () => {
    expect(describeMessageMeta("Claude Code · Opus 5.5", "09:04")).toBe(
      "Claude Code · Opus 5.5 · 09:04",
    );
  });

  it("shows the agent alone when the time could not be formatted", () => {
    expect(describeMessageMeta("Claude Code · Opus 5.5", undefined)).toBe("Claude Code · Opus 5.5");
  });
});

describe("describeWaitingNote", () => {
  it("says since when the thread waits, and for how long", () => {
    expect(describeWaitingNote("09:31", "10m")).toBe("Waiting on you since 09:31 · 10m");
  });

  it("leaves out the time when it could not be formatted", () => {
    expect(describeWaitingNote(undefined, "10m")).toBe("Waiting on you · 10m");
  });
});
