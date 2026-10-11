/**
 * Tests what a Subscription Target expands into.
 *
 * A caller gives only a target; the event router evaluates the CEL source that
 * this expansion produces. The `ref` expansion is checked exactly, because the
 * web app and the spec both quote it. The other three are checked on what a
 * reader can verify without rewriting the expansion here:
 *
 * - the source contains the id the target names
 * - the evaluator accepts the source
 * - for a run target, which events the source matches
 *
 * An expansion that does not compile would be a subscription that can never
 * match, with no error to explain why.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import type { EventSelector, SubscriptionTarget } from "@hercule/contract";
import { evaluateCondition, validateExpression } from "../expressions";
import { provideUnlimitedBudget } from "../expressions/testing";
import { expandEventSelector, expandTarget } from "./targets";

/** A run id, which is a UUIDv7 like every id the controller mints. */
const RUN_ID = "0199f0b7-0000-7000-8000-00000000d001";

/** Returns true if the evaluator accepts a source, validated as `subscription.create` does. */
const isAccepted = (source: string): boolean =>
  Exit.isSuccess(Effect.runSyncExit(validateExpression(source, "event")));

describe("expandTarget", () => {
  it("expands a ref target into the membership test the spec gives", () => {
    const target: SubscriptionTarget = { kind: "ref", ref: "github:pr:o/r#87" };
    expect(expandTarget(target)).toBe('"github:pr:o/r#87" in event.refs');
  });

  it("expands a run target into a source naming that run", () => {
    const source = expandTarget({ kind: "run", runId: RUN_ID });
    expect(source).toContain(RUN_ID);
    expect(isAccepted(source), source).toBe(true);
  });

  it("expands a session target into a source naming that session", () => {
    const source = expandTarget({ kind: "session", sessionId: "s_12" });
    expect(source).toContain("s_12");
    expect(isAccepted(source), source).toBe(true);
  });

  it("expands a request target into a source naming that request", () => {
    const source = expandTarget({ kind: "request", requestId: "pr_7" });
    expect(source).toContain("pr_7");
    expect(isAccepted(source), source).toBe(true);
  });

  it("produces a source the evaluator accepts for every kind of target", () => {
    const targets: ReadonlyArray<SubscriptionTarget> = [
      { kind: "ref", ref: "github:pr:o/r#87" },
      { kind: "run", runId: RUN_ID },
      { kind: "session", sessionId: "s_12" },
      { kind: "request", requestId: "pr_7" },
    ];
    for (const target of targets) {
      const source = expandTarget(target);
      expect(isAccepted(source), `${target.kind}: ${source}`).toBe(true);
    }
  });
});

/**
 * The request expansion must use the event kind the security spec gives for a
 * decision. With a kind nobody emits, the target would silently never match.
 */
describe("the request expansion", () => {
  /** Returns whether the request target's expansion matches an event with these fields. */
  const matchesRequestTarget = (event: {
    readonly source: string;
    readonly kind: string;
    readonly payload: Record<string, unknown>;
  }): boolean =>
    Effect.runSync(
      provideUnlimitedBudget(
        evaluateCondition(expandTarget({ kind: "request", requestId: "pr_7" }), { event }),
      ),
    );

  it("waits on the decision kind the security spec gives", () => {
    expect(expandTarget({ kind: "request", requestId: "pr_7" })).toContain('"permission.decided"');
  });

  it("matches the decision of that request", () => {
    expect(
      matchesRequestTarget({
        source: "platform",
        kind: "permission.decided",
        payload: { requestId: "pr_7" },
      }),
    ).toBe(true);
  });

  it("does not match another request's decision", () => {
    expect(
      matchesRequestTarget({
        source: "platform",
        kind: "permission.decided",
        payload: { requestId: "pr_8" },
      }),
    ).toBe(false);
  });

  it("does not match a decision kind that the controller did not write", () => {
    expect(
      matchesRequestTarget({
        source: "manual",
        kind: "permission.decided",
        payload: { requestId: "pr_7" },
      }),
    ).toBe(false);
  });
});

/**
 * A run target waits on the event its run emits when it ends. Only the
 * controller writes platform events, so an event of the same kind from
 * anywhere else, such as one a plugin declares, must not pass for it.
 */
describe("the run expansion", () => {
  /** Returns whether the run target's expansion matches an event with these fields. */
  const matchesRunTarget = (event: {
    readonly source: string;
    readonly kind: string;
    readonly payload: Record<string, unknown>;
  }): boolean =>
    Effect.runSync(
      provideUnlimitedBudget(
        evaluateCondition(expandTarget({ kind: "run", runId: RUN_ID }), { event }),
      ),
    );

  it("matches each ending event of that run", () => {
    for (const kind of ["run.completed", "run.failed", "run.cancelled"]) {
      expect(matchesRunTarget({ source: "platform", kind, payload: { runId: RUN_ID } }), kind).toBe(
        true,
      );
    }
  });

  it("does not match another run's ending", () => {
    expect(
      matchesRunTarget({
        source: "platform",
        kind: "run.completed",
        payload: { runId: "0199f0b7-0000-7000-8000-00000000d002" },
      }),
    ).toBe(false);
  });

  it("does not match an event of a run kind that the controller did not write", () => {
    expect(
      matchesRunTarget({ source: "manual", kind: "run.completed", payload: { runId: RUN_ID } }),
    ).toBe(false);
  });
});

/**
 * A signal trigger's subscription matches the events its Event Selector
 * accepts. The selector's filter is written for events of its kind, so it must
 * never be evaluated against an event of another kind.
 */
describe("expandEventSelector", () => {
  /** Returns whether the selector's expansion matches an event with these fields. */
  const matchesSelector = (
    selector: EventSelector,
    event: {
      readonly kind: string;
      readonly connectionId?: string;
      readonly payload: Record<string, unknown>;
    },
  ): boolean =>
    Effect.runSync(
      provideUnlimitedBudget(evaluateCondition(expandEventSelector(selector), { event })),
    );

  const ISSUE_SEVEN: EventSelector = {
    kind: "github.issue.opened",
    filter: "event.payload.number == 7",
  };

  it("matches on the kind alone when the selector names no Connection and no filter", () => {
    const selector: EventSelector = { kind: "task.created" };
    expect(expandEventSelector(selector)).toBe('event.kind == "task.created"');
    expect(matchesSelector(selector, { kind: "task.created", payload: {} })).toBe(true);
    expect(matchesSelector(selector, { kind: "task.updated", payload: {} })).toBe(false);
  });

  it("adds no Connection test for any Connection", () => {
    const selector: EventSelector = { kind: "github.issue.opened", connectionId: "any" };
    expect(expandEventSelector(selector)).toBe('event.kind == "github.issue.opened"');
  });

  it("matches only events that arrived through the Connection the selector names", () => {
    const selector: EventSelector = { kind: "github.issue.opened", connectionId: "conn-a" };
    const event = { kind: "github.issue.opened", payload: {} };
    expect(matchesSelector(selector, { ...event, connectionId: "conn-a" })).toBe(true);
    expect(matchesSelector(selector, { ...event, connectionId: "conn-b" })).toBe(false);
  });

  it("matches only events the filter accepts", () => {
    const opened = (number: number) => ({ kind: "github.issue.opened", payload: { number } });
    expect(matchesSelector(ISSUE_SEVEN, opened(7))).toBe(true);
    expect(matchesSelector(ISSUE_SEVEN, opened(8))).toBe(false);
  });

  it("never evaluates the filter against an event of another kind", () => {
    // This event's payload has no `number`, so evaluating the filter on it
    // would fail rather than give false.
    expect(matchesSelector(ISSUE_SEVEN, { kind: "task.created", payload: {} })).toBe(false);
  });

  it("keeps a filter that ends in a comment from swallowing the rest of the expansion", () => {
    const selector: EventSelector = { ...ISSUE_SEVEN, filter: `${ISSUE_SEVEN.filter} // issue 7` };
    expect(isAccepted(expandEventSelector(selector))).toBe(true);
    expect(matchesSelector(selector, { kind: "github.issue.opened", payload: { number: 7 } })).toBe(
      true,
    );
  });

  it("quotes the Connection, so a quotation mark in it cannot change the expression", () => {
    const selector: EventSelector = { kind: "a.b", connectionId: 'x" || true || "' };
    expect(isAccepted(expandEventSelector(selector))).toBe(true);
    expect(matchesSelector(selector, { kind: "a.b", connectionId: "other", payload: {} })).toBe(
      false,
    );
  });
});
