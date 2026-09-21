/**
 * The wrapper's two gates: what a stored expression must pass before it is
 * saved, and what one evaluation reports when it runs too long.
 *
 * Every source here is deliberately far over any modest limit. The concrete
 * limit values belong to the implementation, so these tests assert the name of
 * the limit that was exceeded and that the message carries a number, never the
 * number itself.
 */
import { describe, expect, it } from "vitest";
import { Cause, Duration, Effect, Exit, Option } from "effect";
import {
  checkExpression,
  evaluateExpression,
  ExpressionBudget,
  parseExpression,
  type ExpressionError,
} from "./index";

/** The message an effect failed with, or a thrown report that it succeeded. */
const failureMessage = <A>(effect: Effect.Effect<A, ExpressionError>): string => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit))
    throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`);
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (error === undefined) throw new Error(`expected an error, got ${Cause.pretty(exit.cause)}`);
  return error.message;
};

/** How many numbers a message spells, which is how a named value is found. */
const numbersIn = (message: string): number => (message.match(/\d+/g) ?? []).length;

/**
 * A sum of `leaves` ones, nested in balance so that the node count grows with
 * the leaf count while the depth grows with its logarithm. A flat chain of
 * additions would exceed `maxDepth` at the same time as `maxAstNodes`, and the
 * test could not say which limit the message should name.
 */
const balancedSum = (leaves: number): string => {
  let terms: ReadonlyArray<string> = Array.from({ length: leaves }, () => "1");
  while (terms.length > 1) {
    const joined: Array<string> = [];
    for (let index = 0; index < terms.length; index += 2)
      joined.push(`(${terms[index]} + ${terms[index + 1]})`);
    terms = joined;
  }
  return terms[0]!;
};

const listOf = (elements: number): string =>
  `[${Array.from({ length: elements }, (_unused, index) => index).join(", ")}]`;

const mapOf = (entries: number): string =>
  `{${Array.from({ length: entries }, (_unused, index) => `"k${index}": ${index}`).join(", ")}}`;

const callWith = (args: number): string =>
  `size(${Array.from({ length: args }, () => "1").join(", ")})`;

/**
 * A literal wrapped in `levels` parentheses. Nesting is what the evaluator
 * counts as depth: a chain of unary operators is flat to it, however long.
 */
const parenthesize = (levels: number): string => `${"(".repeat(levels)}true${")".repeat(levels)}`;

describe("checkExpression", () => {
  it.each([
    ["an equality over the envelope", `event.kind == "github.pr.opened"`],
    ["a membership test over refs", `"github:pr:o/r#87" in event.refs`],
    ["a presence test on a loose payload", `has(event.payload.subject) && event.payload.x == 1`],
    ["a bounded macro", `event.payload.labels.exists(label, label == "ci")`],
  ])("passes %s and answers nothing else", (_what, source) => {
    expect(Effect.runSync(checkExpression(source))).toBeUndefined();
  });

  it("refuses a syntax error", () => {
    expect(failureMessage(checkExpression("event.kind =="))).not.toBe("");
  });

  it.each([
    ["maxAstNodes", () => balancedSum(16384)],
    ["maxDepth", () => parenthesize(200)],
    ["maxListElements", () => listOf(10000)],
    ["maxMapEntries", () => mapOf(10000)],
    ["maxCallArguments", () => callWith(200)],
  ])("refuses a source over %s, naming the limit and its value", (limit, build) => {
    const message = failureMessage(checkExpression(build()));

    expect(message).toContain(limit);
    expect(numbersIn(message)).toBeGreaterThanOrEqual(1);
  });

  it("refuses a call to a function nobody registered, naming the function", () => {
    expect(failureMessage(checkExpression(`sendEmail("rogier")`))).toContain("sendEmail");
  });
});

describe("parseExpression", () => {
  it("passes a well-formed source", () => {
    expect(Exit.isSuccess(Effect.runSyncExit(parseExpression(`event.kind == "x"`)))).toBe(true);
  });

  it("refuses a syntax error", () => {
    expect(failureMessage(parseExpression("event.kind =="))).not.toBe("");
  });

  it("refuses a source over a structural limit, naming the limit", () => {
    expect(failureMessage(parseExpression(listOf(10000)))).toContain("maxListElements");
  });
});

describe("evaluateExpression over the wall-clock budget", () => {
  /**
   * A full scan of ninety thousand pairs, against a budget of one
   * millisecond, which takes a few milliseconds on any machine.
   * The list comes from the context, which the parse-time limits do not bound,
   * so a caller can make one evaluation run long; the budget is shrunk rather
   * than the work grown, because the wrapper reports an overrun and cannot
   * interrupt one, so the test must not wait one out.
   */
  const context = {
    event: { payload: { items: Array.from({ length: 300 }, (_unused, index) => index) } },
  };
  const slow = "event.payload.items.exists(a, event.payload.items.exists(b, a + b == -1))";
  const withBudget = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.provideService(effect, ExpressionBudget, Duration.millis(1));

  it("reports the overrun with the budget and the elapsed time, and remembers nothing", () => {
    const first = failureMessage(withBudget(evaluateExpression(slow, context)));

    expect(first.toLowerCase()).toContain("budget");
    expect(numbersIn(first)).toBeGreaterThanOrEqual(2);

    // The wrapper does not retire an expression that went over: the same
    // source runs again and reports again, because the matcher re-evaluates
    // it on the next tick.
    const second = failureMessage(withBudget(evaluateExpression(slow, context)));
    expect(second.toLowerCase()).toContain("budget");

    // An overrun leaves the shared environment usable for everything else.
    // This one runs on the default budget: a first read of a list costs around
    // a millisecond on a cold run, which says nothing about a budget and
    // everything about the machine.
    expect(Effect.runSync(evaluateExpression(`event.payload.items[0] == 0`, context))).toBe(true);
  });
});
