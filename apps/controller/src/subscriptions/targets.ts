/**
 * Expands a Subscription Target into a CEL expression.
 *
 * A caller gives a target; the event router evaluates an expression. The
 * expansion between the two lives here and nowhere else, so what a
 * subscription waits on and what a person reads on the row always agree.
 *
 * Every id is written into the source as a JSON string literal, which is a CEL
 * string literal too. A ref, a run id or a Permission Request id is
 * caller-written text, and quoting it by hand would let a quotation mark in it
 * change the expression.
 */
import type { SubscriptionTarget } from "@hercule/contract";

/** Returns the value as a CEL string literal. A JSON string is also a valid CEL string literal. */
const quoteAsCelString = (value: string): string => JSON.stringify(value);

/**
 * Returns the CEL source that matches the events a target waits on.
 *
 * The session and request expansions read platform events that this version
 * does not emit yet. They are written out because workflows and Permission
 * Requests will depend on them, and because `subscription.create` rejects
 * those target kinds by name rather than storing a condition that can never
 * match.
 */
export const expandTarget = (target: SubscriptionTarget): string => {
  switch (target.kind) {
    case "ref":
      return `${quoteAsCelString(target.ref)} in event.refs`;
    case "run":
      return `event.kind.startsWith("run.") && event.payload.runId == ${quoteAsCelString(target.runId)}`;
    case "session":
      return (
        `event.kind.startsWith("session.") && ` +
        `event.payload.sessionId == ${quoteAsCelString(target.sessionId)}`
      );
    case "request":
      // A caller waiting on a Permission Request waits for its decision.
      // `permission.decided` is the event kind the security spec gives that
      // decision.
      return (
        `event.kind == "permission.decided" && ` +
        `event.payload.requestId == ${quoteAsCelString(target.requestId)}`
      );
  }
};
