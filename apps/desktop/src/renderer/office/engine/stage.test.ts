/**
 * Tests the stage's frame pacing with made-up animation frame times, as
 * displays of different refresh rates give them. The tests check that:
 *
 * - no display draws more frames a second than the cap, and none draws fewer
 *   than 90% of it. A 165 Hz display draws a moving camera at 55 frames a
 *   second, on every third beat: drawing 60 would take uneven gaps of two
 *   and three beats;
 * - beats that come a little early still draw on the beat they belong to;
 * - after a pause, the frames go on at the cap, not in a burst.
 */
import { describe, expect, it } from "vitest";
import { decideFrameSlot } from "./stage";

/**
 * Returns how many frames a display at `hz` draws in `seconds` at a cap of
 * `rate` frames a second. `early` returns how many ms early each beat comes.
 */
const countFrames = (
  hz: number,
  rate: number,
  seconds: number,
  early: (beat: number) => number = () => 0,
): number => {
  let slot = -Infinity;
  let drawn = 0;
  for (let beat = 0; beat < seconds * hz; beat++) {
    const next = decideFrameSlot(slot, (beat * 1000) / hz - early(beat), rate);
    if (next === null) continue;
    slot = next;
    drawn++;
  }
  return drawn;
};

describe("decideFrameSlot", () => {
  it.each([60, 120, 144, 165, 240])(
    "draws 27 to 30 frames a second of ambient life on a %i Hz display",
    (hz) => {
      const drawn = countFrames(hz, 30, 10);

      expect(drawn).toBeLessThanOrEqual(300);
      expect(drawn).toBeGreaterThanOrEqual(270);
    },
  );

  it.each([60, 120, 144, 165, 240])(
    "draws 54 to 60 frames a second for a moving camera on a %i Hz display",
    (hz) => {
      const drawn = countFrames(hz, 60, 10);

      expect(drawn).toBeLessThanOrEqual(600);
      expect(drawn).toBeGreaterThanOrEqual(540);
    },
  );

  it("draws on every fourth beat of a 120 Hz display when beats come up to a millisecond early", () => {
    const early = (beat: number) => ((beat * 7) % 11) / 10;

    expect(countFrames(120, 30, 10, early)).toBe(300);
  });

  it("goes on at the cap after a pause, without a burst", () => {
    let slot = decideFrameSlot(-Infinity, 0, 30)!;
    const drawnAt: number[] = [];
    // The window was hidden for two seconds; a 120 Hz display's beats resume.
    for (let now = 2000; now < 2200; now += 1000 / 120) {
      const next = decideFrameSlot(slot, now, 30);
      if (next === null) continue;
      slot = next;
      drawnAt.push(Math.round(now));
    }

    expect(drawnAt).toEqual([2000, 2033, 2067, 2100, 2133, 2167]);
  });
});
