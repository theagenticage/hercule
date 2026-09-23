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
  validateCondition,
  validateExpression,
  validateTemplate,
  evaluateExpression,
  ExpressionBudget,
  isTemplate,
  parseExpression,
  type ExpressionError,
} from "./index";

/** The message an effect failed with, or a thrown report that it succeeded. */
const readFailureMessage = <A>(effect: Effect.Effect<A, ExpressionError>): string => {
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
const countNumbers = (message: string): number => (message.match(/\d+/g) ?? []).length;

/**
 * A sum of `leaves` ones, nested in balance so that the node count grows with
 * the leaf count while the depth grows with its logarithm. A flat chain of
 * additions would exceed `maxDepth` at the same time as `maxAstNodes`, and the
 * test could not say which limit the message should name.
 */
const buildBalancedSum = (leaves: number): string => {
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

const buildSizeCall = (args: number): string =>
  `size(${Array.from({ length: args }, () => "1").join(", ")})`;

/**
 * A literal wrapped in `levels` parentheses. Nesting is what the evaluator
 * counts as depth: a chain of unary operators is flat to it, however long.
 */
const parenthesize = (levels: number): string => `${"(".repeat(levels)}true${")".repeat(levels)}`;

describe("validateExpression", () => {
  it.each([
    ["an equality over the envelope", `event.kind == "github.pr.opened"`],
    ["a membership test over refs", `"github:pr:o/r#87" in event.refs`],
    ["a presence test on a loose payload", `has(event.payload.subject) && event.payload.x == 1`],
    ["a bounded macro", `event.payload.labels.exists(label, label == "ci")`],
  ])("passes %s and answers nothing else", (_what, source) => {
    expect(Effect.runSync(validateExpression(source, "event"))).toBeUndefined();
  });

  it("refuses a syntax error", () => {
    expect(readFailureMessage(validateExpression("event.kind ==", "event"))).not.toBe("");
  });

  it.each([
    ["maxAstNodes", () => buildBalancedSum(16384)],
    ["maxDepth", () => parenthesize(200)],
    ["maxListElements", () => buildListSource(10000)],
    ["maxMapEntries", () => buildMapSource(10000)],
    ["maxCallArguments", () => buildSizeCall(200)],
  ])("refuses a source over %s, naming the limit and its value", (limit, build) => {
    const message = readFailureMessage(validateExpression(build(), "event"));

    expect(message).toContain(limit);
    expect(countNumbers(message)).toBeGreaterThanOrEqual(1);
  });

  it("refuses a call to a function nobody registered, naming the function", () => {
    expect(readFailureMessage(validateExpression(`sendEmail("rogier")`, "event"))).toContain(
      "sendEmail",
    );
  });
});

describe("validateExpression with a scope", () => {
  it("accepts event in the event scope, and rejects steps", () => {
    expect(Effect.runSync(validateExpression(`event.payload.number > 3`, "event"))).toBeUndefined();

    const message = readFailureMessage(
      validateExpression(`steps.review.output.id == "x"`, "event"),
    );
    expect(message).toContain("steps");
    expect(message).toContain("can read only event");
  });

  it("accepts inputs and steps in the run scope, and explains how to get a value from the event", () => {
    expect(
      Effect.runSync(validateExpression(`has(inputs.pr) && steps.review.output.ok`, "run")),
    ).toBeUndefined();

    const message = readFailureMessage(validateExpression(`event.kind == "task.updated"`, "run"));
    expect(message).toContain("can read only inputs and steps");
    expect(message).toContain("inputs.<name>");
  });

  it("rejects a variable that no scope declares, and names it in the message", () => {
    expect(readFailureMessage(validateExpression(`request.id == 1`, "run"))).toContain("request");
  });
});

describe("validateCondition", () => {
  it("accepts a source of type bool, and a source of type dyn", () => {
    for (const [source, scope] of [
      [`event.payload.number > 3`, "event"],
      [`has(event.payload.subject)`, "event"],
      [`event.payload.merged`, "event"],
      [`steps.review.output.approved`, "run"],
    ] as const) {
      expect(Effect.runSync(validateCondition(source, scope)), source).toBeUndefined();
    }
  });

  it("rejects a source whose type is known and is not bool, and names the type", () => {
    const text = readFailureMessage(validateCondition(`'yes'`, "run"));
    expect(text).toContain("string");
    expect(text).toContain("true or false");

    expect(readFailureMessage(validateCondition(`size(inputs.labels)`, "run"))).toContain("int");
  });

  it("rejects what validateExpression rejects, with the same message", () => {
    expect(readFailureMessage(validateCondition(`steps.x.output.ok`, "event"))).toBe(
      readFailureMessage(validateExpression(`steps.x.output.ok`, "event")),
    );
  });
});

describe("validateTemplate", () => {
  it("accepts a string with no expressions, and expressions that read inputs and steps", () => {
    for (const template of [
      "Review the pull request.",
      "Review {{ inputs.prUrl }}. The last reviewer said {{ steps.review.output.notes }}.",
      "{{inputs.count + 1}}",
    ]) {
      expect(Effect.runSync(validateTemplate(template)), template).toBeUndefined();
    }
  });

  it("accepts {{ '{{' }}, which is how a literal {{ is written", () => {
    expect(Effect.runSync(validateTemplate("Write {{ '{{' }} where a template starts."))).toBe(
      undefined,
    );
  });

  it("rejects a {{ with no closing }}, and gives its character position", () => {
    const message = readFailureMessage(
      validateTemplate("Review {{ inputs.prUrl }} and {{ steps.x"),
    );
    expect(message).toContain("character 31");
    expect(message).toContain("}}");
  });

  it("rejects the first expression that is not valid in the run scope, and gives its character position", () => {
    const syntax = readFailureMessage(validateTemplate("Review {{ inputs.prUrl + }}."));
    expect(syntax).toContain("character 8");
    expect(syntax).toContain("not valid CEL");

    const scoped = readFailureMessage(validateTemplate("{{ inputs.a }} {{ event.payload.title }}"));
    expect(scoped).toContain("character 16");
    expect(scoped).toContain("event");
  });

  it("counts an emoji before the {{ as one character", () => {
    // The emoji is two UTF-16 code units, so counting code units would give character 4.
    expect(readFailureMessage(validateTemplate("😀 {{ inputs.a"))).toContain("character 3 ");
    expect(readFailureMessage(validateTemplate("😀 {{ event.id }}"))).toContain("character 3 ");
  });
});

describe("isTemplate", () => {
  it("returns true only for a string that contains {{", () => {
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
    expect(readFailureMessage(parseExpression("event.kind =="))).not.toBe("");
  });

  it("returns only the reason, as a stored health message needs, and not the fix that validation adds", () => {
    const parsed = readFailureMessage(parseExpression("event.kind =="));
    const checked = readFailureMessage(validateExpression("event.kind ==", "event"));

    expect(parsed).toMatch(/^that expression is not valid CEL: /);
    expect(checked).toMatch(/^This expression is not valid CEL: /);
    expect(checked).toMatch(/Correct the expression\.$/);
    expect(parsed).not.toContain("Correct");
  });

  it("refuses a source over a structural limit, naming the limit", () => {
    expect(readFailureMessage(parseExpression(buildListSource(10000)))).toContain(
      "maxListElements",
    );
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
    expect(readFailureMessage(parseExpression(source))).toContain(
      readEvaluatorSummary(readFailureMessage(evaluateExpression(source, {}))),
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
    const first = readFailureMessage(withBudget(evaluateExpression(source, context)));

    expect(first.toLowerCase()).toContain("budget");
    expect(countNumbers(first)).toBeGreaterThanOrEqual(2);

    // The wrapper does not retire an expression that went over: the same
    // source runs again and reports again, because the router re-evaluates
    // it on the next tick.
    const second = readFailureMessage(withBudget(evaluateExpression(source, context)));
    expect(second.toLowerCase()).toContain("budget");

    // An overrun leaves the shared environment usable for everything else:
    // the same source, on the shipped budget, answers.
    expect(Effect.runSync(evaluateExpression(source, context))).toBe(true);
  });
});
