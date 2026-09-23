/**
 * Expressions: the CEL sources Hercule stores on a subscription or in a
 * workflow, and evaluates against one event or inside one run.
 *
 * A source is checked once, when it is saved, so a broken condition is refused
 * while a user is there to read why. It is checked in the scope of the place
 * where it is written, so that an expression that reads a value its place does
 * not have is refused at save and does not fail at each evaluation. It is
 * evaluated against one context when a match is decided, and it is parsed when
 * a caller wants the compiled program in its hand.
 *
 * A template is text with expressions in it, each one written `{{ expr }}`,
 * such as the prompt of an agent step. Each of its expressions is checked in
 * the scope of a run.
 *
 * The environments are built here once and shared by every call, because
 * building one is expensive.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { excerptMessage, quoteWritten } from "@hercule/contract";
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
 * The environment that parses and evaluates. No function is registered on it,
 * or on the environments that check, which is what makes the function
 * whitelist pure: a registered function is the only way a custom, and possibly
 * asynchronous, handler enters, and an asynchronous handler is the only thing
 * that turns `evaluate` into a `Promise`. So evaluation is synchronous by
 * construction, and a condition can call nothing that reaches outside the
 * context it is given.
 *
 * It declares no variable and reads each one from the context it is handed.
 * Which variables a source may read was decided when the source was checked.
 */
const environment = new Environment({
  // Context variables are dynamic. A payload is loosely shaped, and a plain
  // JSON number stays a number this way instead of needing a BigInt literal
  // to compare against.
  unlistedVariablesAreDyn: true,
  limits: SOURCE_LIMITS,
});

/**
 * What an expression can read, which the place where it is written decides.
 * An expression over one event, such as the filter of a trigger, reads
 * `event`. An expression inside a run, such as the condition of an edge or an
 * expression in a prompt, reads the run's `inputs` and `steps`.
 */
export type ExpressionScope = "event" | "run";

/** The variables of each scope, which are all dynamic, as the evaluation's are. */
const SCOPE_VARIABLES: Record<ExpressionScope, ReadonlyArray<string>> = {
  event: ["event"],
  run: ["inputs", "steps"],
};

/**
 * An environment that declares only the variables of one scope, so a check
 * refuses a source that reads any other. The limits are the evaluation's own.
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
 * The one line of an evaluator error that names what is wrong, as one
 * sentence. Its `message` repeats that line and adds an excerpt of the source
 * under a caret, which belongs in a terminal and not in a stored health
 * message. The line can repeat what the author wrote, so it is cut short.
 */
const readSummary = (failure: unknown): string => {
  const summary = (failure as { readonly summary?: unknown } | null)?.summary;
  return excerptMessage(typeof summary === "string" ? summary : String(failure));
};

/** The summary the evaluator writes when a source is over a structural limit. */
const OVER_LIMIT = /^Exceeded (\w+) \((\d+)\)/;

/**
 * Why a source was refused, and what its author does about it, kept apart.
 * `reason` completes a sentence that begins with the expression, and ends it:
 * a stored health message says only why an evaluation failed, and only a
 * check that a user is waiting on adds the repair. A source over a limit is
 * valid CEL that is too big, and telling its author it is not CEL sends them
 * looking for a syntax error that is not there.
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

/** What a check of a source finds wrong, as the evaluator reports it. */
type CheckFailure = NonNullable<ReturnType<Environment["check"]>["error"]>;

/**
 * Why a check refused a source, and what its author does about it. A source
 * that reads a variable its scope does not declare is valid CEL in the wrong
 * place, so its author is told which values the place has, and why.
 */
const describeCheckRefusal = (failure: CheckFailure, scope: ExpressionScope): string => {
  const variable: unknown = failure.node?.args;
  if (failure.code !== "unknown_variable" || typeof variable !== "string") {
    const { reason, repair } = describeRefusal(failure);
    return `This expression ${reason} ${repair}`;
  }
  const unavailable = `This expression reads ${quoteWritten(variable)}, which is not available here.`;
  if (scope === "event") {
    return `${unavailable} An expression here is evaluated against one event, before the event reaches a run. Read only event.`;
  }
  // The one mistake with a known repair: the event did not enter the run, but
  // a start trigger can copy what the run needs of it into an input.
  const repair =
    variable === "event"
      ? " A run does not keep the event: map the value from the event into an input at the start trigger, and read it as inputs.<name>."
      : "";
  return `${unavailable} An expression here is evaluated inside a run. Read only inputs and steps.${repair}`;
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
 * The type a source gives, when it may be stored at a place of this scope. A
 * variable is `dyn`, so a source that reads one gives a type that is known
 * only when it is evaluated.
 */
const typeCheckSource = (
  source: string,
  scope: ExpressionScope,
): Effect.Effect<string, ExpressionError> =>
  Effect.suspend(() => {
    const result = SCOPED_ENVIRONMENTS[scope].check(source);
    return result.valid
      ? Effect.succeed(result.type!)
      : Effect.fail(new ExpressionError({ message: describeCheckRefusal(result.error!, scope) }));
  });

/**
 * Whether a source may be stored at a place of this scope. It answers nothing:
 * what a caller does with a source it has accepted is parse it or evaluate it,
 * and both read the source again. This is the one path a user is waiting on,
 * so its message carries the repair too.
 */
export const checkExpression = (
  source: string,
  scope: ExpressionScope,
): Effect.Effect<void, ExpressionError> => Effect.asVoid(typeCheckSource(source, scope));

/**
 * Whether a source may be stored at a place of this scope where its value
 * decides yes or no, such as a filter or a condition. Only `true` says yes
 * when it is evaluated, so a source whose type is known and is not `bool`
 * could never say yes, and is refused. A `dyn` source is accepted, because
 * its type is known only when it is evaluated.
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
              `This expression gives a value of type ${type}, but here it must give true or false. ` +
              "Write an expression that gives true or false, such as a comparison with ==.",
          }),
        ),
  );

/** The mark that opens an expression in a template. */
const TEMPLATE_OPEN = "{{";

/** The mark that closes an expression in a template. */
const TEMPLATE_CLOSE = "}}";

/**
 * Whether a text is a template, which is whether it holds a `{{`. Each `{{`
 * opens an expression, and a literal `{{` is written `{{ '{{' }}`, so what
 * such a text says is known only when a run renders it.
 */
export const isTemplate = (text: string): boolean => text.includes(TEMPLATE_OPEN);

/** One expression of a template: its source, and where its `{{` stands in the text. */
interface TemplateExpression {
  readonly source: string;
  readonly offset: number;
}

/**
 * The expressions of a template, in order, or the offset of a `{{` that no
 * `}}` closes. An expression ends at the first `}}` after its `{{`, as a tag
 * does in Mustache, so the reader needs to know nothing of CEL. An expression
 * that must hold `}}` itself writes it another way: `'}' + '}'`, or a space
 * between two closing braces of a map.
 */
const readTemplateExpressions = (
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
 * How many characters a text holds before an offset. An offset counts UTF-16
 * code units, and a character such as an emoji is two of them, so a position
 * that an author counts in the text is not the offset.
 */
const countCharactersBefore = (text: string, offset: number): number =>
  [...text.slice(0, offset)].length;

/**
 * Whether a template may be stored: every `{{` is closed, and each expression
 * passes the check in the scope of a run, because a run renders the template.
 * The refusal names the first problem by its character in the text, counted
 * from 1, because the text may hold many expressions.
 */
export const checkTemplate = (template: string): Effect.Effect<void, ExpressionError> =>
  Effect.suspend(() => {
    const read = readTemplateExpressions(template);
    if (Result.isFailure(read)) {
      return Effect.fail(
        new ExpressionError({
          message:
            `The {{ at character ${String(countCharactersBefore(template, read.failure) + 1)} opens an expression that no }} closes. ` +
            "Close the expression with }}, or write {{ '{{' }} for a literal {{.",
        }),
      );
    }
    return Effect.forEach(
      read.success,
      (expression) =>
        Effect.mapError(
          checkExpression(expression.source, "run"),
          (refusal) =>
            new ExpressionError({
              message: `The expression that the {{ at character ${String(countCharactersBefore(template, expression.offset) + 1)} opens, and the first }} after it closes, is not valid. ${refusal.message}`,
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
