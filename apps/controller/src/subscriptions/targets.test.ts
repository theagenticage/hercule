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
 *
 * An expansion that does not compile would be a subscription that can never
 * match, with no error to explain why.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import type { SubscriptionTarget } from "@hercule/contract";
import { validateExpression } from "../expressions";
import { expandTarget } from "./targets";

/** Returns true if the evaluator accepts a source, validated as `subscription.create` does. */
const isAccepted = (source: string): boolean =>
  Exit.isSuccess(Effect.runSyncExit(validateExpression(source, "event")));

describe("expandTarget", () => {
  it("expands a ref target into the membership test the spec gives", () => {
    const target: SubscriptionTarget = { kind: "ref", ref: "github:pr:o/r#87" };
    expect(expandTarget(target)).toBe('"github:pr:o/r#87" in event.refs');
  });

  it("expands a run target into a source naming that run", () => {
    const source = expandTarget({ kind: "run", runId: "r_3" });
    expect(source).toContain("r_3");
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
      { kind: "run", runId: "r_3" },
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
