/**
 * The probe result every adapter returns when a probe has nothing to report
 * except an error. It lives in one module because a probe result the
 * controller cannot read leaves the harness row with no information at all.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProbeResult, UsageReading } from "@hercule/protocol";
import { truncateFact } from "./text";

/** Long enough for a harness starting cold, short enough that the Fleet page does not look hung. */
export const PROBE_DEADLINE: Duration.Duration = Duration.seconds(15);

/**
 * Returns a probe result with an `error` auth status and no models. The
 * message is truncated to the length the protocol allows, so a long message
 * cannot make the whole report fail.
 */
export const buildFailedProbe = (harnessVersion: string | null, message: string): ProbeResult => ({
  harnessVersion,
  auth: { status: "error", message: truncateFact(message) },
  models: [],
  usage: null,
});

/** The longest a probe's optional usage read may take, when the probe has the time. */
export const USAGE_READ_DEADLINE: Duration.Duration = Duration.seconds(5);

/**
 * The part of the probe deadline a usage read leaves unused, so the probe
 * returns its answer before the deadline fires.
 */
const USAGE_READ_MARGIN: Duration.Duration = Duration.seconds(1);

/**
 * Runs a probe's optional usage read with only the time the probe has left, and
 * returns its readings, or `null` when the read has no readings, fails, or runs
 * out of time. Never fails.
 *
 * The usage read is worth less than the probe's auth and models. The time it
 * gets is the remaining `PROBE_DEADLINE` minus a margin, and at most
 * `USAGE_READ_DEADLINE`. A slow version, account or model read therefore costs
 * the probe its usage, and never its auth and models.
 *
 * `probeStartedAt` is `Clock.currentTimeMillis` at the start of the probe.
 */
export const readUsageWithinProbeBudget = (
  probeStartedAt: number,
  read: Effect.Effect<ReadonlyArray<UsageReading> | null>,
): Effect.Effect<ReadonlyArray<UsageReading> | null> =>
  Effect.gen(function* () {
    const spent = (yield* Clock.currentTimeMillis) - probeStartedAt;
    const remaining =
      Duration.toMillis(PROBE_DEADLINE) - spent - Duration.toMillis(USAGE_READ_MARGIN);
    const allowed = Math.min(remaining, Duration.toMillis(USAGE_READ_DEADLINE));
    const readings =
      allowed <= 0 ? Option.none() : yield* Effect.timeoutOption(read, Duration.millis(allowed));
    if (Option.isNone(readings)) {
      yield* Effect.logWarning("The usage read ran out of the time the probe had left");
      return null;
    }
    return readings.value;
  });
