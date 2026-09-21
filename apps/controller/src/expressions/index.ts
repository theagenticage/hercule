/**
 * Expressions: the CEL sources Hercule stores on a subscription or a trigger
 * and evaluates against one event.
 *
 * A source is checked once, when it is saved, so a broken condition is refused
 * while a user is there to read why. It is evaluated against one context when
 * a match is decided, and it is parsed when a caller wants the compiled
 * program in its hand.
 *
 * One environment is built here and shared by every call: building one is
 * expensive, and every expression in Hercule reads the same language.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
// This is the only module that reaches the evaluator, which is what keeps the
// implementation swappable: `@bufbuild/cel` is the named fallback, and a
// stored condition holds CEL source and nothing derived from it, so a swap
// costs no migration.
import { Environment } from "@marcbachmann/cel-js";

/**
 * A source that cannot be used, or one evaluation that did not produce a
 * usable answer. One type, because a caller does the same thing with every
 * case: refuse the save, or read the failure as a no-match and store the
 * message as the subscription's health.
 */
export class ExpressionError extends Schema.TaggedError<ExpressionError>()("ExpressionError", {
  message: Schema.String,
}) {}

/**
 * How long one evaluation may run before the wrapper reports it.
 *
 * A condition over one event envelope is a handful of comparisons and takes
 * microseconds. 50 ms is far above any healthy evaluation and still short
 * enough that a reader of the message sees an outlier rather than a number
 * near the normal one. Tests shrink it instead of building a slow expression.
 */
const EVALUATION_BUDGET: Duration.Duration = Duration.millis(50);

export const ExpressionBudget = Context.Reference<Duration.Duration>(
  "hercule/controller/expressions/ExpressionBudget",
  { defaultValue: (): Duration.Duration => EVALUATION_BUDGET },
);

/**
 * The structural limits a source must stay under. They are set on the shared
 * environment rather than left to a caller, because they are the only real
 * bound on what one evaluation costs: the evaluator meters nothing while it
 * runs. Every value is far above what a real condition needs.
 */
const SOURCE_LIMITS = {
  // A long condition is around thirty nodes. The room above that is for a
  // condition an agent generates, which is wordier than one a person writes.
  maxAstNodes: 1000,
  // Nesting of parentheses, member reads, index reads and conditionals.
  // `event.payload.subject.title` is four levels deep.
  maxDepth: 32,
  // A list literal in a condition holds the values one field is compared
  // against: a few kinds, a few labels.
  maxListElements: 64,
  // A map literal is rarer still, and is read the same way.
  maxMapEntries: 64,
  // The widest standard function a condition calls takes three arguments.
  maxCallArguments: 8,
};

/**
 * The shared environment. No function is registered on it, which is what makes
 * the function whitelist pure: a registered function is the only way a custom,
 * and possibly asynchronous, handler enters, and an asynchronous handler is
 * the only thing that turns `evaluate` into a `Promise`. So evaluation is
 * synchronous by construction, and a condition can call nothing that reaches
 * outside the context it is given.
 */
const environment = new Environment({
  // Context variables are dynamic. A payload is loosely shaped, and a plain
  // JSON number stays a number this way instead of needing a BigInt literal
  // to compare against.
  unlistedVariablesAreDyn: true,
  limits: SOURCE_LIMITS,
});

/**
 * The one line of an evaluator error that names what is wrong. Its `message`
 * repeats that line and adds an excerpt of the source under a caret, which
 * belongs in a terminal and not in a stored health message.
 */
const readSummary = (failure: unknown): string => {
  const summary = (failure as { readonly summary?: unknown } | null)?.summary;
  return typeof summary === "string" ? summary : String(failure);
};

/** The summary the evaluator writes when a source is over a structural limit. */
const OVER_LIMIT = /^Exceeded (\w+) \((\d+)\)/;

/**
 * Why a source was refused, and what its author does about it. A source over a
 * limit is valid CEL that is too big, and telling its author it is not CEL
 * sends them looking for a syntax error that is not there.
 */
const describeRefusal = (
  failure: unknown,
): { readonly reason: string; readonly repair: string } => {
  const summary = readSummary(failure);
  const overLimit = OVER_LIMIT.exec(summary);
  return overLimit === null
    ? {
        reason: `that expression is not valid CEL: ${summary}`,
        repair: "Correct it and save it again",
      }
    : {
        reason: `that expression exceeds the limit on ${overLimit[1]} (${overLimit[2]})`,
        repair: "Shorten it and save it again",
      };
};

/** A source compiled once, called with one context per event. */
export interface CompiledExpression {
  (context: Record<string, unknown>): unknown;
}

/**
 * The compiled program, for a caller that holds one source and calls it
 * itself. It only parses: it does not type-check the source the way
 * `checkExpression` does, and it puts no wall-clock guard around the calls the
 * caller then makes. It is not the matcher's path - the matcher evaluates
 * through `evaluateExpression`, which is guarded.
 */
export const parseExpression = (
  source: string,
): Effect.Effect<CompiledExpression, ExpressionError> =>
  Effect.try({
    try: (): CompiledExpression => environment.parse(source),
    catch: (failure) => new ExpressionError({ message: describeRefusal(failure).reason }),
  });

/**
 * Whether a source may be stored. It answers nothing: what a caller does with
 * a source it has accepted is parse it or evaluate it, and both read the
 * source again. This is the one path a user is waiting on, so its message
 * carries the repair too.
 */
export const checkExpression = (source: string): Effect.Effect<void, ExpressionError> =>
  Effect.suspend(() => {
    const result = environment.check(source);
    if (result.valid) return Effect.void;
    const { reason, repair } = describeRefusal(result.error);
    return Effect.fail(new ExpressionError({ message: `${reason}. ${repair}` }));
  });

/**
 * One evaluation against one context, with a wall-clock guard.
 *
 * The guard reports; it does not bound. The evaluator offers no timeout, no
 * fuel and no step budget, and evaluation is synchronous, so nothing on this
 * thread can stop an evaluation once it starts: the elapsed time is measured
 * around the call and an overrun becomes a failure the caller reads as a
 * no-match. The real bound on one evaluation is the parse-time limits above.
 *
 * An overrun retires nothing either. The same source is evaluated again on the
 * next tick and can go over again, which is deliberate: a slow evaluation is a
 * fact about the event as much as about the expression.
 */
export const evaluateExpression = (
  source: string,
  context: Record<string, unknown>,
): Effect.Effect<unknown, ExpressionError> =>
  Effect.gen(function* () {
    const budget = Duration.toMillis(yield* ExpressionBudget);
    const startedAt = performance.now();
    const value: unknown = yield* Effect.try({
      // The evaluator answers `any`; an answer is read by the caller that
      // knows what it asked for, so it leaves this domain as `unknown`.
      try: (): unknown => environment.evaluate(source, context),
      catch: (failure) =>
        new ExpressionError({
          message: `that expression could not be evaluated: ${readSummary(failure)}`,
        }),
    });
    const elapsed = performance.now() - startedAt;
    if (elapsed <= budget) return value;
    return yield* Effect.fail(
      new ExpressionError({
        message: `that expression ran for ${Math.round(elapsed)} ms, over the ${budget} ms budget, so its answer is not used`,
      }),
    );
  });
