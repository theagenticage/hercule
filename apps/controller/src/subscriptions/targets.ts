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
import { ANY_CONNECTION, type EventSelector, type SubscriptionTarget } from "@hercule/contract";

/** Returns the value as a CEL string literal. A JSON string is also a valid CEL string literal. */
const quoteAsCelString = (value: string): string => JSON.stringify(value);

/**
 * Returns the CEL source that matches the events a target waits on.
 *
 * The session expansion reads platform events that this version does not
 * emit yet. It is written out because workflows will depend on it, and
 * because `subscription.create` rejects that target kind by name rather than
 * storing a condition that can never match.
 *
 * A request target is never given to `subscription.create`: `permission.request`
 * opens it for the asking session itself.
 */
export const expandTarget = (target: SubscriptionTarget): string => {
  switch (target.kind) {
    case "ref":
      return `${quoteAsCelString(target.ref)} in event.refs`;
    case "run":
      // Only the controller writes platform events. A plugin whose id is
      // `run` could declare a `run.*` kind, and an event of it must not pass
      // for news about the run.
      return (
        `event.source == "platform" && event.kind.startsWith("run.") && ` +
        `event.payload.runId == ${quoteAsCelString(target.runId)}`
      );
    case "session":
      return (
        `event.kind.startsWith("session.") && ` +
        `event.payload.sessionId == ${quoteAsCelString(target.sessionId)}`
      );
    case "request":
      // A session waiting on a Permission Request waits for its decision,
      // the `permission.decided` platform event. As for a run target, an
      // event of the same kind from a plugin must not pass for the decision.
      return (
        `event.source == "platform" && event.kind == "permission.decided" && ` +
        `event.payload.requestId == ${quoteAsCelString(target.requestId)}`
      );
  }
};

/**
 * Returns the CEL source that matches the events a signal trigger's Event
 * Selector accepts:
 *
 * - the event's kind is the selector's kind;
 * - when the selector names one Connection, the event arrived through it.
 *   `any`, or no Connection at all for a core kind, adds no test;
 * - the selector's filter, if it has one, holds.
 *
 * The tests are joined with `&&`, which stops at the first false one. So the
 * filter, written for events of the selector's kind, is never evaluated
 * against an event of another kind, where it could fail on a missing field.
 */
export const expandEventSelector = (selector: EventSelector): string =>
  [
    `event.kind == ${quoteAsCelString(selector.kind)}`,
    ...(selector.connectionId === undefined || selector.connectionId === ANY_CONNECTION
      ? []
      : [`event.connectionId == ${quoteAsCelString(selector.connectionId)}`]),
    // The filter goes on lines of its own, so a `//` comment at its end
    // cannot swallow the closing parenthesis.
    ...(selector.filter === undefined ? [] : [`(\n${selector.filter}\n)`]),
  ].join(" && ");
