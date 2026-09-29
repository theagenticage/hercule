/**
 * Tests `checkSchedulerInterval`: the controller refuses to start a Scheduler
 * that looks for due cron triggers less often than a trigger may fire late.
 */
import { describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { FIRING_TOLERANCE } from "../../workflows";
import { checkSchedulerInterval, SchedulerInterval } from "./scheduler";

/** Runs the check with the Scheduler looking every `interval`. */
const checkInterval = (interval: Duration.Duration) =>
  Effect.runPromiseExit(
    checkSchedulerInterval.pipe(Effect.provideService(SchedulerInterval, interval)),
  );

describe("checking the Scheduler's interval", () => {
  it("accepts the default interval, and one just under the firing tolerance", async () => {
    expect(Exit.isSuccess(await Effect.runPromiseExit(checkSchedulerInterval))).toBe(true);
    const justUnder = Duration.subtract(FIRING_TOLERANCE, Duration.millis(1));
    expect(Exit.isSuccess(await checkInterval(justUnder))).toBe(true);
  });

  it("dies, naming both durations, when the interval is as long as the firing tolerance", async () => {
    const exit = await checkInterval(FIRING_TOLERANCE);
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
      "The Scheduler interval is 1m, and it must be shorter than 1m",
    );
  });
});
