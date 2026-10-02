import { describe, expect, it } from "vitest";
import {
  computeNextMinuteTick,
  countMinutesLeft,
  describeCodeExpiry,
  describeMinutes,
} from "./minutes-left";

const EXPIRES_AT = "2026-10-02T09:15:00.000Z";
const EXPIRY = Date.parse(EXPIRES_AT);

describe("countMinutesLeft", () => {
  it("rounds the time a code has left up to whole minutes", () => {
    expect(countMinutesLeft(EXPIRES_AT, EXPIRY - 15 * 60_000)).toBe(15);
    expect(countMinutesLeft(EXPIRES_AT, EXPIRY - 14 * 60_000 - 1_000)).toBe(15);
  });

  it("returns 1 while the code has seconds left", () => {
    expect(countMinutesLeft(EXPIRES_AT, EXPIRY - 1)).toBe(1);
  });

  it("returns 0 from the moment the code expires", () => {
    expect(countMinutesLeft(EXPIRES_AT, EXPIRY)).toBe(0);
    expect(countMinutesLeft(EXPIRES_AT, EXPIRY + 60_000)).toBe(0);
  });
});

describe("describeMinutes", () => {
  it("uses the singular for one minute only", () => {
    expect(describeMinutes(1)).toBe("1 minute");
    expect(describeMinutes(12)).toBe("12 minutes");
  });
});

describe("describeCodeExpiry", () => {
  it("describes how long the code still works, or that it has expired", () => {
    expect(describeCodeExpiry(12)).toBe("The code expires in 12 minutes.");
    expect(describeCodeExpiry(1)).toBe("The code expires in 1 minute.");
    expect(describeCodeExpiry(0)).toBe("The code has expired.");
  });
});

describe("computeNextMinuteTick", () => {
  it("lands on the next whole minute before the expiry", () => {
    const now = EXPIRY - 14 * 60_000 - 20_000;
    expect(computeNextMinuteTick(EXPIRES_AT, now)).toBe(EXPIRY - 14 * 60_000);
  });

  it("waits a whole minute when the count has just changed", () => {
    const now = EXPIRY - 3 * 60_000;
    expect(computeNextMinuteTick(EXPIRES_AT, now)).toBe(EXPIRY - 2 * 60_000);
  });

  it("lands on the expiry for the last minute", () => {
    expect(computeNextMinuteTick(EXPIRES_AT, EXPIRY - 30_000)).toBe(EXPIRY);
  });

  it("returns null once the code has expired", () => {
    expect(computeNextMinuteTick(EXPIRES_AT, EXPIRY)).toBeNull();
  });

  it("moves the count down by one at each tick", () => {
    let now = EXPIRY - 2 * 60_000 - 5_000;
    const counts = [countMinutesLeft(EXPIRES_AT, now)];
    for (let tick = computeNextMinuteTick(EXPIRES_AT, now); tick !== null;) {
      now = tick;
      counts.push(countMinutesLeft(EXPIRES_AT, now));
      tick = computeNextMinuteTick(EXPIRES_AT, now);
    }
    expect(counts).toEqual([3, 2, 1, 0]);
  });
});
