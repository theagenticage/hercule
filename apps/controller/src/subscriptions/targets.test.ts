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
import type { SubscriptionTarget } from "@hercule/contract";
import { evaluateCondition, validateExpression } from "../expressions";
import { provideUnlimitedBudget } from "../expressions/testing";
import { expandTarget } from "./targets";

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
  it("waits on the decision kind the security spec gives", () => {
    expect(expandTarget({ kind: "request", requestId: "pr_7" })).toContain('"permission.decided"');
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
