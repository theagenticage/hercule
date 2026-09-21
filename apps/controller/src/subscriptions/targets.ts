/**
 * What a Subscription Target expands into.
 *
 * A caller names a target; the matcher evaluates an expression. The expansion
 * between the two lives here and nowhere else, so what a subscription waits on
 * and what a person reads on the row can never drift apart.
 *
 * Every subject is written into the source as a JSON string literal, which is
 * a CEL string literal too. A ref, a run id or a request id is caller-written
 * text, and quoting it by hand would let a quotation mark in it change the
 * expression.
 */
import type { SubscriptionTarget } from "@hercule/contract";

/** The value as a CEL literal. */
const literal = (value: string): string => JSON.stringify(value);

/**
 * The CEL source a target waits on.
 *
 * Three of the four expansions read a platform event that this version does
 * not emit yet. They are written out because they are what the workflows and
 * the permission tickets turn on, and because `subscription.create` refuses
 * those targets by name rather than storing a condition nobody checked.
 */
export const expandTarget = (target: SubscriptionTarget): string => {
  switch (target.kind) {
    case "ref":
      return `${literal(target.ref)} in event.refs`;
    case "run":
      return `event.kind.startsWith("run.") && event.payload.runId == ${literal(target.runId)}`;
    case "session":
      return (
        `event.kind.startsWith("session.") && ` +
        `event.payload.sessionId == ${literal(target.sessionId)}`
      );
    case "request":
      // The decision on one Permission Request, which is the one thing a
      // caller waiting on a request is waiting for.
      return (
        `event.kind == "request.decided" && ` +
        `event.payload.requestId == ${literal(target.requestId)}`
      );
  }
};
