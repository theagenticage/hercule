/** Tests reading, checking and writing a time of day as the contract stores it, `HH:MM`. */
import { describe, expect, it } from "vitest";
import { findTimeOfDayError, formatTimeOfDay, parseTimeOfDay } from "./time-of-day";

const REFUSED = ["7:30", "24:00", "12:60", "12:5", " 12:00", "noon", ""];

describe("parseTimeOfDay", () => {
  it.each([
    ["00:00", { hour: 0, minute: 0 }],
    ["07:30", { hour: 7, minute: 30 }],
    ["23:59", { hour: 23, minute: 59 }],
  ])("reads %s", (text, time) => {
    expect(parseTimeOfDay(text)).toEqual(time);
  });

  it.each(REFUSED)("returns null for %j, which the contract refuses", (text) => {
    expect(parseTimeOfDay(text)).toBeNull();
  });
});

describe("findTimeOfDayError", () => {
  it("returns null for a time the contract accepts", () => {
    expect(findTimeOfDayError("04:00")).toBeNull();
  });

  it.each(REFUSED)("explains how to write %j instead", (text) => {
    expect(findTimeOfDayError(text)).toBe(
      `"${text}" is not a time. Write it as HH:MM on a 24-hour clock, such as 07:00.`,
    );
  });
});

describe("formatTimeOfDay", () => {
  it("writes two digits for the hour and the minute", () => {
    expect(formatTimeOfDay(7, 0)).toBe("07:00");
    expect(formatTimeOfDay(23, 45)).toBe("23:45");
  });

  it("writes text that parseTimeOfDay reads back", () => {
    expect(parseTimeOfDay(formatTimeOfDay(4, 5))).toEqual({ hour: 4, minute: 5 });
  });
});
