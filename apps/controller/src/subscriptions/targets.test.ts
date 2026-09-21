/**
 * What a Subscription Target expands into.
 *
 * A target is the only thing a caller names; the matcher evaluates the CEL
 * source this expansion produces. The `ref` expansion is pinned exactly,
 * because the web app and the spec both quote it. The other three are asserted
 * on what a reader can check without re-writing the expansion here: the source
 * names the thing the target names, and the source is one the evaluator
 * accepts - an expansion that does not compile is a subscription that can
 * never match and never says why.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import type { SubscriptionTarget } from "@hercule/contract";
import { checkExpression } from "../expressions";
import { expandTarget } from "./index";

/** Whether the evaluator accepts a source, as `subscription.create` asks it. */
const accepted = (source: string): boolean =>
  Exit.isSuccess(Effect.runSyncExit(checkExpression(source)));

describe("expandTarget", () => {
  it("expands a ref target into the membership test the spec pins", () => {
    const target: SubscriptionTarget = { kind: "ref", ref: "github:pr:o/r#87" };
    expect(expandTarget(target)).toBe('"github:pr:o/r#87" in event.refs');
  });

  it("expands a run target into a source naming that run", () => {
    const source = expandTarget({ kind: "run", runId: "r_3" });
    expect(source).toContain("r_3");
    expect(accepted(source), source).toBe(true);
  });

  it("expands a session target into a source naming that session", () => {
    const source = expandTarget({ kind: "session", sessionId: "s_12" });
    expect(source).toContain("s_12");
    expect(accepted(source), source).toBe(true);
  });

  it("expands a request target into a source naming that request", () => {
    const source = expandTarget({ kind: "request", requestId: "pr_7" });
    expect(source).toContain("pr_7");
    expect(accepted(source), source).toBe(true);
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
      expect(accepted(source), `${target.kind}: ${source}`).toBe(true);
    }
  });
});

/**
 * Added beside the criterion's own cases: the request expansion names the kind
 * the security document pins for a decision, and a kind nobody emits would
 * make the whole target silently dead.
 */
describe("the request expansion", () => {
  it("waits on the decision kind the security document names", () => {
    expect(expandTarget({ kind: "request", requestId: "pr_7" })).toContain('"permission.decided"');
  });
});
