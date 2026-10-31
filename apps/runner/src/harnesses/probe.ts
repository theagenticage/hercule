/**
 * The probe result every adapter returns when a probe has nothing to report
 * except an error. It lives in one module because a probe result the
 * controller cannot read leaves the provider row with no information at all.
 */
import * as Duration from "effect/Duration";
import type { ProbeResult } from "@hercule/protocol";
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
});
