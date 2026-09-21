/**
 * What every adapter's probe answers with when it has nothing to report but a
 * reason. One module, because a probe result the controller cannot read is a
 * provider row that says nothing at all.
 */
import * as Duration from "effect/Duration";
import type { ProbeResult } from "@hercule/protocol";
import { fact } from "./text";

/** Long enough for a cold harness, short enough that a Fleet page does not look hung. */
export const PROBE_DEADLINE: Duration.Duration = Duration.seconds(15);

/** Cut to what the protocol carries rather than failing the whole report. */
export const probeFailed = (harnessVersion: string | null, message: string): ProbeResult => ({
  harnessVersion,
  auth: { status: "error", message: fact(message) },
  models: [],
});
