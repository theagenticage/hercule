/**
 * The corpus: the subset of CEL that Hercule's conditions rely on, pinned
 * against one representative event envelope. If a swap of the evaluator
 * changes any answer here, a stored condition changes meaning, so every case
 * states its expected value rather than only that it evaluates.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { evaluateExpression } from "./index";
import { provideUnlimitedBudget } from "./testing";

/** One event envelope as expressions see it. `raw` is not part of it. */
const event = {
  id: 7,
  source: "manual",
  connectionId: null,
  system: "github",
  kind: "github.pr.opened",
  occurredAt: "2026-09-21T10:00:00.000Z",
  receivedAt: "2026-09-21T10:00:01.000Z",
  dedupKey: "manual-7",
  refs: ["github:pr:o/r#87", "github:repo:o/r"],
  url: "https://github.com/o/r/pull/87",
  payload: {
    subject: { repo: "o/r", number: 87, title: "Fix the flaky routing test", state: "open" },
    additions: 42,
    labels: ["bug", "ci"],
  },
  actor: "user",
};

const context = { event };

const evaluate = (source: string): unknown =>
  Effect.runSync(provideUnlimitedBudget(evaluateExpression(source, context)));

describe("the expression corpus", () => {
  it.each([
    ["equality on kind", `event.kind == "github.pr.opened"`, true],
    ["inequality on kind", `event.kind == "github.issue.opened"`, false],
    ["equality on source", `event.source == "manual"`, true],
    ["equality on system", `event.system == "github"`, true],
    ["a ref that is there", `"github:pr:o/r#87" in event.refs`, true],
    ["a ref that is not", `"github:pr:o/r#88" in event.refs`, false],
    ["a payload field that is there", `has(event.payload.subject.title)`, true],
    ["a payload field that is not", `has(event.payload.subject.author)`, false],
    ["a plain JSON integer against a literal", `event.payload.additions == 42`, true],
    ["a plain JSON integer compared by order", `event.payload.subject.number > 10`, true],
    ["a string prefix", `event.payload.subject.title.startsWith("Fix")`, true],
    ["a string prefix that does not hold", `event.payload.subject.title.startsWith("Add")`, false],
    ["a bounded exists over a list", `event.payload.labels.exists(l, l == "ci")`, true],
    ["a bounded exists that finds nothing", `event.payload.labels.exists(l, l == "docs")`, false],
    [
      "a compound condition over kind and refs",
      `event.kind.startsWith("github.pr.") && "github:pr:o/r#87" in event.refs`,
      true,
    ],
  ])("answers %s", (_what, source, expected) => {
    expect(evaluate(source)).toBe(expected);
  });

  it("answers a payload integer as a number, so no comparison needs a BigInt", () => {
    const value = evaluate("event.payload.subject.number");

    expect(value).toBe(87);
    expect(typeof value).toBe("number");
  });

  it("refuses to read event.raw rather than answering null", () => {
    const exit = Effect.runSyncExit(
      provideUnlimitedBudget(evaluateExpression("event.raw", context)),
    );

    expect(Exit.isSuccess(exit)).toBe(false);
    if (Exit.isSuccess(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error?.message ?? "").toContain("raw");
  });

  it("answers synchronously, never with a Promise", () => {
    const value = evaluate(`event.kind == "github.pr.opened"`);

    expect(value).not.toBeInstanceOf(Promise);
    expect(value).toBe(true);
  });
});
