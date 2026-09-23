/**
 * Expressions: the CEL sources Hercule stores on a subscription or in a
 * workflow, and evaluates against one event or inside one run.
 *
 * A source is validated once, when it is saved, so a broken condition is
 * rejected while a user is there to read why. Validation uses the scope of the
 * place where the source is written (see `ExpressionScope`). So an expression
 * that reads a variable its place does not have fails when it is saved, and
 * not at every evaluation. A source is evaluated against one context when a
 * match is decided, and it is parsed when a caller wants the compiled program.
 *
 * A template is a string with expressions in it, each written `{{ expr }}`,
 * such as the prompt of an agent step. Each of its expressions is validated in
 * the run scope.
 *
 * The environments are built once here and shared by every call, because
 * building one is expensive.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { shortenLibraryMessage, quoteAuthorText } from "@hercule/contract";
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
 * The structural limits a source must stay under. They are set on every
 * environment here rather than left to a caller, because they are the only
 * real bound on what one evaluation costs: the evaluator meters nothing while
 * it runs. Every value is far above what a real condition needs.
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
 * The environment used to parse and evaluate. No function is registered on it,
 * or on the scoped environments used for validation. That keeps the function
 * whitelist pure: a registered function is the only way a custom, and possibly
 * asynchronous, handler enters, and an asynchronous handler is the only thing
 * that turns `evaluate` into a `Promise`. So evaluation is synchronous by
 * construction, and a condition can call nothing that reaches outside the
 * context it is given.
 *
 * It declares no variables and reads each one from the evaluation context.
 * Which variables a source may read was already enforced when the source was
 * validated.
 */
const environment = new Environment({
  // Context variables are dynamic. A payload is loosely shaped, and a plain
  // JSON number stays a number this way instead of needing a BigInt literal
  // to compare against.
  unlistedVariablesAreDyn: true,
  limits: SOURCE_LIMITS,
});

/**
 * Which variables an expression can read. This depends on where the
 * expression is written:
 *
 * - `event`: an expression over one event, such as a trigger's filter, reads
 *   `event`.
 * - `run`: an expression inside a run, such as an edge condition or an
 *   expression in a prompt, reads the run's `inputs` and `steps`.
 */
export type ExpressionScope = "event" | "run";

/** The variables each scope declares. All are `dyn`, as in the evaluation environment. */
const SCOPE_VARIABLES: Record<ExpressionScope, ReadonlyArray<string>> = {
  event: ["event"],
  run: ["inputs", "steps"],
};

/**
 * Builds an environment that declares only the variables of one scope, so
 * validation rejects a source that reads any other variable. It uses the same
 * limits as evaluation.
 */
const buildScopedEnvironment = (scope: ExpressionScope): Environment =>
  SCOPE_VARIABLES[scope].reduce(
    (built, variable) => built.registerVariable(variable, "dyn"),
    new Environment({ unlistedVariablesAreDyn: false, limits: SOURCE_LIMITS }),
  );

const SCOPED_ENVIRONMENTS: Record<ExpressionScope, Environment> = {
  event: buildScopedEnvironment("event"),
  run: buildScopedEnvironment("run"),
};

/**
 * Returns the one-line summary of an evaluator error, as a sentence. The
 * error's `message` repeats that line and adds an excerpt of the source under
 * a caret, which belongs in a terminal and not in a stored health message. The
 * summary can quote what the author wrote, so it is truncated.
 */
const readSummary = (failure: unknown): string => {
  const summary = (failure as { readonly summary?: unknown } | null)?.summary;
  return shortenLibraryMessage(typeof summary === "string" ? summary : String(failure));
};

/** The summary the evaluator writes when a source is over a structural limit. */
const OVER_LIMIT = /^Exceeded (\w+) \((\d+)\)/;

/**
 * Returns why a source was rejected (`reason`) and how its author can fix it
 * (`repair`), as two strings. `reason` finishes a sentence that starts with
 * the expression, such as "is not valid CEL: ...". The two are kept apart
 * because a stored health message contains only the reason an evaluation
 * failed. Only a validation that a user is waiting on adds the fix.
 *
 * A source over a limit is valid CEL that is too big. Telling its author it is
 * not CEL sends them looking for a syntax error that is not there.
 */
const describeRefusal = (
  failure: unknown,
): { readonly reason: string; readonly repair: string } => {
  const summary = readSummary(failure);
  const overLimit = OVER_LIMIT.exec(summary);
  return overLimit === null
    ? { reason: `is not valid CEL: ${summary}`, repair: "Correct the expression." }
    : {
        reason: `exceeds the limit on ${overLimit[1]} (${overLimit[2]}).`,
        repair: "Make the expression shorter.",
      };
};

/** The error the evaluator's `check` returns for an invalid source. */
type CheckFailure = NonNullable<ReturnType<Environment["check"]>["error"]>;

/**
 * Returns the message for a source that failed validation, including how to
 * fix it. A source that reads a variable its scope does not declare is valid
 * CEL in the wrong place, so the message lists the variables that are
 * available there, and explains why.
 */
const describeCheckFailure = (failure: CheckFailure, scope: ExpressionScope): string => {
  const variable: unknown = failure.node?.args;
  if (failure.code !== "unknown_variable" || typeof variable !== "string") {
    const { reason, repair } = describeRefusal(failure);
    return `This expression ${reason} ${repair}`;
  }
  const unavailable = `This expression reads ${quoteAuthorText(variable)}, which is not available here.`;
  if (scope === "event") {
    return `${unavailable} An expression here is evaluated against one event, before any run starts, so it can read only event.`;
  }
  // Reading `event` inside a run is a common mistake with a known fix. The run
  // does not keep the event, but a start trigger can map the values the run
  // needs into inputs.
  const repair =
    variable === "event"
      ? " A run does not keep the event. Map the value you need from the event into an input at the start trigger, and read it as inputs.<name>."
      : "";
  return `${unavailable} An expression here is evaluated inside a run, so it can read only inputs and steps.${repair}`;
};

/** A source compiled once, called with one context per event. */
export interface CompiledExpression {
  (context: Record<string, unknown>): unknown;
}

/**
 * The compiled program, for a caller that evaluates one source against many
 * contexts and does not want it read again for each of them. It only parses:
 * it does not type-check the source the way `checkExpression` does. The guard
 * is not lost by compiling: what a caller hands the program to is
 * `evaluateExpression`, which takes a program as readily as a source.
 */
export const parseExpression = (
  source: string,
): Effect.Effect<CompiledExpression, ExpressionError> =>
  Effect.try({
    try: (): CompiledExpression => environment.parse(source),
    catch: (failure) =>
      new ExpressionError({ message: `that expression ${describeRefusal(failure).reason}` }),
  });

/**
 * Type-checks a source in a scope and returns its type, such as `bool`, `int`
 * or `dyn`. Fails with `ExpressionError` if the source is not valid in that
 * scope. Every variable is `dyn`, so a source whose value comes straight from
 * a variable, such as `event.payload.merged`, has type `dyn`: its real type is
 * known only when it is evaluated.
 */
const typeCheckSource = (
  source: string,
  scope: ExpressionScope,
): Effect.Effect<string, ExpressionError> =>
  Effect.suspend(() => {
    const result = SCOPED_ENVIRONMENTS[scope].check(source);
    return result.valid
      ? Effect.succeed(result.type!)
      : Effect.fail(new ExpressionError({ message: describeCheckFailure(result.error!, scope) }));
  });

/**
 * Validates a source for the given scope. Fails with `ExpressionError` if the
 * source is not valid there. Returns nothing on success, because a caller
 * parses or evaluates the source later, and both read the source again. A
 * user is waiting on this validation, so the error message also explains how
 * to fix the source.
 */
export const checkExpression = (
  source: string,
  scope: ExpressionScope,
): Effect.Effect<void, ExpressionError> => Effect.asVoid(typeCheckSource(source, scope));

/**
 * Validates a source whose value decides yes or no, such as a filter or a
 * condition. Fails with `ExpressionError` if the source is not valid in the
 * scope, or if its type is known and is not `bool`. Only `true` counts as yes
 * when the source is evaluated, so a source of another type could never pass.
 * A `dyn` source is accepted, because its type is known only when it is
 * evaluated.
 */
export const checkCondition = (
  source: string,
  scope: ExpressionScope,
): Effect.Effect<void, ExpressionError> =>
  Effect.flatMap(typeCheckSource(source, scope), (type) =>
    type === "bool" || type === "dyn"
      ? Effect.void
      : Effect.fail(
          new ExpressionError({
            message:
              `This expression evaluates to a value of type ${type}, but here it must evaluate to true or false. ` +
              "Write an expression that evaluates to true or false, such as a comparison with ==.",
          }),
        ),
  );

const TEMPLATE_OPEN = "{{";
const TEMPLATE_CLOSE = "}}";

/**
 * Returns true if the string contains `{{`, which makes it a template. Every
 * `{{` starts an expression (a literal `{{` is written `{{ '{{' }}`), so the
 * final string is known only when a run renders the template.
 */
export const isTemplate = (text: string): boolean => text.includes(TEMPLATE_OPEN);

/** An expression found in a template. `offset` is the UTF-16 index of its `{{`. */
interface TemplateExpression {
  readonly source: string;
  readonly offset: number;
}

/**
 * Finds the expressions in a template, in order. Returns a failed `Result`
 * with the offset of the first `{{` that has no closing `}}`.
 *
 * An expression ends at the first `}}` after its `{{`, as a Mustache tag does,
 * so a reader does not need to know CEL to see where it ends. An expression
 * that must contain `}}` writes it another way: `'}' + '}'`, or with a space
 * between the two closing braces of a nested map.
 */
const parseTemplateExpressions = (
  template: string,
): Result.Result<ReadonlyArray<TemplateExpression>, number> => {
  const expressions: Array<TemplateExpression> = [];
  let from = 0;
  for (;;) {
    const offset = template.indexOf(TEMPLATE_OPEN, from);
    if (offset === -1) return Result.succeed(expressions);
    const end = template.indexOf(TEMPLATE_CLOSE, offset + TEMPLATE_OPEN.length);
    if (end === -1) return Result.fail(offset);
    expressions.push({ source: template.slice(offset + TEMPLATE_OPEN.length, end), offset });
    from = end + TEMPLATE_CLOSE.length;
  }
};

/**
 * Returns the number of characters in `text` before `offset`. An offset counts
 * UTF-16 code units, and a character such as an emoji takes two, so the offset
 * is not the position an author would count.
 */
const countCharactersBefore = (text: string, offset: number): number =>
  [...text.slice(0, offset)].length;

/**
 * Validates a template. Fails with `ExpressionError` if a `{{` has no closing
 * `}}`, or if an expression is not valid in the run scope (a run renders the
 * template). The message gives the position of the first error as a character
 * number, counted from 1, because a template can contain many expressions.
 */
export const checkTemplate = (template: string): Effect.Effect<void, ExpressionError> =>
  Effect.suspend(() => {
    const read = parseTemplateExpressions(template);
    if (Result.isFailure(read)) {
      return Effect.fail(
        new ExpressionError({
          message:
            `The {{ at character ${String(countCharactersBefore(template, read.failure) + 1)} has no closing }}. ` +
            "Close the expression with }}, or write {{ '{{' }} for a literal {{.",
        }),
      );
    }
    return Effect.forEach(
      read.success,
      (expression) =>
        Effect.mapError(
          checkExpression(expression.source, "run"),
          (error) =>
            new ExpressionError({
              message: `The expression that starts with the {{ at character ${String(countCharactersBefore(template, expression.offset) + 1)} and ends at the next }} is not valid. ${error.message}`,
            }),
        ),
      { discard: true },
    );
  });

/**
 * One evaluation against one context, with a wall-clock guard.
 *
 * The expression is a source or a program `parseExpression` made of one. The
 * two answer alike, so a caller evaluating one source against many contexts
 * compiles it once and hands the program over, and a caller with one context
 * hands the source over and never mentions the compilation step.
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
 *
 * An evaluation that exactly reaches the budget is over it, not under it. That
 * makes a budget of zero refuse every evaluation by definition, which is how a
 * test asks for the failure path without depending on a clock that may not
 * have moved between two reads.
 */
export const evaluateExpression = (
  expression: string | CompiledExpression,
  context: Record<string, unknown>,
): Effect.Effect<unknown, ExpressionError> =>
  Effect.gen(function* () {
    const budget = Duration.toMillis(yield* ExpressionBudget);
    const startedAt = performance.now();
    const value: unknown = yield* Effect.try({
      // The evaluator answers `any`; an answer is read by the caller that
      // knows what it asked for, so it leaves this domain as `unknown`.
      try: (): unknown =>
        typeof expression === "string"
          ? environment.evaluate(expression, context)
          : expression(context),
      catch: (failure) =>
        new ExpressionError({
          message: `that expression could not be evaluated: ${readSummary(failure)}`,
        }),
    });
    const elapsed = performance.now() - startedAt;
    if (elapsed < budget) return value;
    return yield* Effect.fail(
      new ExpressionError({
        message:
          `that expression ran for ${Math.round(elapsed)} ms, which is not under the ` +
          `${budget} ms budget, so its answer is not used`,
      }),
    );
  });
