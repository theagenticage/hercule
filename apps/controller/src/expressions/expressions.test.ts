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
  checkCondition,
  checkExpression,
  checkTemplate,
  evaluateExpression,
  ExpressionBudget,
  isTemplate,
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

/**
 * What the evaluator itself said about a source, without the sentence the
 * wrapper puts around it. The wrapper says what the caller was doing - saving,
 * compiling, evaluating - and the rest is the complaint about the source.
 */
const readEvaluatorSummary = (message: string): string => message.slice(message.indexOf(": ") + 2);

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

const buildListSource = (elements: number): string =>
  `[${Array.from({ length: elements }, (_unused, index) => index).join(", ")}]`;

const buildMapSource = (entries: number): string =>
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
    expect(Effect.runSync(checkExpression(source, "event"))).toBeUndefined();
  });

  it("refuses a syntax error", () => {
    expect(failureMessage(checkExpression("event.kind ==", "event"))).not.toBe("");
  });

  it.each([
    ["maxAstNodes", () => balancedSum(16384)],
    ["maxDepth", () => parenthesize(200)],
    ["maxListElements", () => buildListSource(10000)],
    ["maxMapEntries", () => buildMapSource(10000)],
    ["maxCallArguments", () => callWith(200)],
  ])("refuses a source over %s, naming the limit and its value", (limit, build) => {
    const message = failureMessage(checkExpression(build(), "event"));

    expect(message).toContain(limit);
    expect(numbersIn(message)).toBeGreaterThanOrEqual(1);
  });

  it("refuses a call to a function nobody registered, naming the function", () => {
    expect(failureMessage(checkExpression(`sendEmail("rogier")`, "event"))).toContain("sendEmail");
  });
});

describe("checkExpression in a scope", () => {
  it("lets an expression over one event read event, and nothing a run has", () => {
    expect(Effect.runSync(checkExpression(`event.payload.number > 3`, "event"))).toBeUndefined();

    const message = failureMessage(checkExpression(`steps.review.output.id == "x"`, "event"));
    expect(message).toContain("steps");
    expect(message).toContain("Read only event");
  });

  it("lets an expression inside a run read inputs and steps, and tells how to reach the event", () => {
    expect(
      Effect.runSync(checkExpression(`has(inputs.pr) && steps.review.output.ok`, "run")),
    ).toBeUndefined();

    const message = failureMessage(checkExpression(`event.kind == "task.updated"`, "run"));
    expect(message).toContain("Read only inputs and steps");
    expect(message).toContain("inputs.<name>");
  });

  it("refuses a variable no scope declares, naming it", () => {
    expect(failureMessage(checkExpression(`request.id == 1`, "run"))).toContain("request");
  });
});

describe("checkCondition", () => {
  it("passes a source that gives a bool, and one whose type is known only when it is evaluated", () => {
    for (const [source, scope] of [
      [`event.payload.number > 3`, "event"],
      [`has(event.payload.subject)`, "event"],
      [`event.payload.merged`, "event"],
      [`steps.review.output.approved`, "run"],
    ] as const) {
      expect(Effect.runSync(checkCondition(source, scope)), source).toBeUndefined();
    }
  });

  it("refuses a source whose type is known and is not bool, naming the type and saying what the place needs", () => {
    const text = failureMessage(checkCondition(`'yes'`, "run"));
    expect(text).toContain("string");
    expect(text).toContain("true or false");

    expect(failureMessage(checkCondition(`size(inputs.labels)`, "run"))).toContain("int");
  });

  it("refuses what checkExpression refuses, with the same message", () => {
    expect(failureMessage(checkCondition(`steps.x.output.ok`, "event"))).toBe(
      failureMessage(checkExpression(`steps.x.output.ok`, "event")),
    );
  });
});

describe("checkTemplate", () => {
  it("passes a text with no expression, and expressions over inputs and steps", () => {
    for (const template of [
      "Review the pull request.",
      "Review {{ inputs.prUrl }}. The last reviewer said {{ steps.review.output.notes }}.",
      "{{inputs.count + 1}}",
    ]) {
      expect(Effect.runSync(checkTemplate(template)), template).toBeUndefined();
    }
  });

  it("reads {{ '{{' }} as an expression whose value is a literal {{", () => {
    expect(Effect.runSync(checkTemplate("Write {{ '{{' }} where a template starts."))).toBe(
      undefined,
    );
  });

  it("refuses a {{ that no }} closes, at its character", () => {
    const message = failureMessage(checkTemplate("Review {{ inputs.prUrl }} and {{ steps.x"));
    expect(message).toContain("character 31");
    expect(message).toContain("}}");
  });

  it("refuses the first expression that is not valid in a run, at its character", () => {
    const syntax = failureMessage(checkTemplate("Review {{ inputs.prUrl + }}."));
    expect(syntax).toContain("character 8");
    expect(syntax).toContain("not valid CEL");

    const scoped = failureMessage(checkTemplate("{{ inputs.a }} {{ event.payload.title }}"));
    expect(scoped).toContain("character 16");
    expect(scoped).toContain("event");
  });

  it("counts an emoji before the {{ as one character, as the author counts it", () => {
    // The emoji is two UTF-16 code units, so an offset would name character 4.
    expect(failureMessage(checkTemplate("😀 {{ inputs.a"))).toContain("character 3 ");
    expect(failureMessage(checkTemplate("😀 {{ event.id }}"))).toContain("character 3 ");
  });
});

describe("isTemplate", () => {
  it("says whether a text holds a {{, which opens an expression", () => {
    expect(isTemplate("{{ inputs.labels }}")).toBe(true);
    expect(isTemplate("Write {{ '{{' }} here.")).toBe(true);
    expect(isTemplate("A plain title with } and { in it")).toBe(false);
  });
});

describe("parseExpression", () => {
  it("passes a well-formed source", () => {
    expect(Exit.isSuccess(Effect.runSyncExit(parseExpression(`event.kind == "x"`)))).toBe(true);
  });

  it("refuses a syntax error", () => {
    expect(failureMessage(parseExpression("event.kind =="))).not.toBe("");
  });

  it("says why a source cannot be used, as a stored health message does, without the repair a save adds", () => {
    const parsed = failureMessage(parseExpression("event.kind =="));
    const checked = failureMessage(checkExpression("event.kind ==", "event"));

    expect(parsed).toMatch(/^that expression is not valid CEL: /);
    expect(checked).toMatch(/^This expression is not valid CEL: /);
    expect(checked).toMatch(/Correct the expression\.$/);
    expect(parsed).not.toContain("Correct");
  });

  it("refuses a source over a structural limit, naming the limit", () => {
    expect(failureMessage(parseExpression(buildListSource(10000)))).toContain("maxListElements");
  });

  it("answers, for a compiled source, what the source itself answers", () => {
    const context = { event: { kind: "github.pr.opened", refs: ["github:pr:o/r#87"] } };
    const source = `event.kind == "github.pr.opened" && "github:pr:o/r#87" in event.refs`;
    const program = Effect.runSync(parseExpression(source));

    expect(Effect.runSync(evaluateExpression(program, context))).toBe(true);
    expect(Effect.runSync(evaluateExpression(program, context))).toBe(
      Effect.runSync(evaluateExpression(source, context)),
    );
    // And a compiled program is called again with another context, which is
    // what compiling it is for.
    expect(
      Effect.runSync(
        evaluateExpression(program, { event: { kind: "github.pr.closed", refs: [] } }),
      ),
    ).toBe(false);
  });

  it("refuses a source with what the evaluator said, which is what evaluating it says too", () => {
    const source = "event.kind ==";

    // A caller reading the refusal reads the same complaint whichever of the
    // two it called, so compiling a source first tells it nothing new.
    expect(failureMessage(parseExpression(source))).toContain(
      readEvaluatorSummary(failureMessage(evaluateExpression(source, {}))),
    );
  });
});

describe("evaluateExpression over the wall-clock budget", () => {
  /**
   * A budget of zero, because an evaluation that reaches its budget is over
   * it: every evaluation is then over budget whatever the clock did between
   * two reads. The alternative - a slow expression against a short budget -
   * depends on the machine, and the wrapper reports an overrun rather than
   * interrupting one, so a test could not wait it out either.
   */
  const context = { event: { payload: { items: [0, 1, 2] } } };
  const source = "event.payload.items[0] == 0";
  const withBudget = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.provideService(effect, ExpressionBudget, Duration.zero);

  it("reports the overrun with the budget and the elapsed time, and remembers nothing", () => {
    const first = failureMessage(withBudget(evaluateExpression(source, context)));

    expect(first.toLowerCase()).toContain("budget");
    expect(numbersIn(first)).toBeGreaterThanOrEqual(2);

    // The wrapper does not retire an expression that went over: the same
    // source runs again and reports again, because the router re-evaluates
    // it on the next tick.
    const second = failureMessage(withBudget(evaluateExpression(source, context)));
    expect(second.toLowerCase()).toContain("budget");

    // An overrun leaves the shared environment usable for everything else:
    // the same source, on the shipped budget, answers.
    expect(Effect.runSync(evaluateExpression(source, context))).toBe(true);
  });
});
