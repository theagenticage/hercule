import type { TrackingRow } from "./tracking";

/** Where opening a row of Tracking goes. */
export type TrackingRowDestination =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "thread"; readonly sessionId: string }
  | { readonly kind: "signal"; readonly signalId: string };

/**
 * Decides where opening `row` goes. A Needs you row goes to what waits on the
 * user, because that is what the user came to answer:
 *
 * - by a Request, the thread of the session that asks;
 * - by a signal, that signal in Intake's To do.
 *
 * A row in any other state goes to the page of its run.
 */
export const decideTrackingRowDestination = (row: TrackingRow): TrackingRowDestination => {
  if (row.state !== "needs-you") return { kind: "run", runId: row.run.id };
  return row.waitsOn.kind === "request"
    ? { kind: "thread", sessionId: row.waitsOn.session.sessionId }
    : { kind: "signal", signalId: row.waitsOn.signal.id };
};
