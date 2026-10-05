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
 *
 * `isUnresolvedReference` is true when an evaluation failed only because the
 * expression read a key that the context does not have, such as a step that
 * has not run yet. A signal trigger's correlation is read against a run that
 * is still running, so for it that case means "no match yet" and not a broken
 * expression.
 */
export class ExpressionError extends Schema.TaggedError<ExpressionError>()("ExpressionError", {
  message: Schema.String,
  isUnresolvedReference: Schema.optionalKey(Schema.Boolean),
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
 * The two operands of a binary operator, as CEL hands them to a handler. A
 * whole number (int) arrives as a `bigint`, a decimal (double) as a `number`.
 */
type Operand = bigint | number;

/** The arithmetic operators that combine a whole number and a decimal. */
const ARITHMETIC: Record<"+" | "-" | "*" | "/" | "%", (left: number, right: number) => number> = {
  "+": (left, right) => left + right,
  "-": (left, right) => left - right,
  "*": (left, right) => left * right,
  "/": (left, right) => left / right,
  "%": (left, right) => left % right,
};

/**
 * Builds an environment with the structural limits and the operators every
 * expression gets, whether it is being validated or evaluated. Validation and
 * evaluation share this one function, so a save accepts exactly what a run can
 * evaluate.
 *
 * Standard CEL keeps whole numbers (int) and decimals (double) apart, and a
 * number read from the context is always a decimal, because the context is
 * plain JSON. So `inputs.count + 1` fails in standard CEL. An author should
 * never have to think about that, so the operators below extend CEL:
 *
 * - `+ - * / %` between a whole number and a decimal, in either order, give a
 *   decimal. `%` also works between two decimals. Two whole numbers stay whole,
 *   so `7 / 2` is still 3: the evaluator's own `int / int` cannot be replaced.
 * - `==` and `!=` between a whole number and a decimal compare the values, so
 *   `3 == 3.0` is true. Ordering (`<`, `>=`) already compares across the two.
 * - `+` between a string and a number, in either order, joins them as text. A
 *   whole decimal is written without `.0`, as JavaScript writes it.
 * - A list or map literal may mix value types, such as `[1, inputs.price]`.
 *
 * Spec 07 section 5 owns these extensions.
 *
 * Every handler is pure and synchronous. A registered handler is the only way
 * custom code enters the evaluator, and an asynchronous one is the only thing
 * that would turn `evaluate` into a `Promise`, so evaluation stays synchronous
 * and an expression can reach nothing outside the context it is given. No
 * function is registered.
 */
const buildEnvironment = (unlistedVariablesAreDyn: boolean): Environment => {
  const built = new Environment({
    unlistedVariablesAreDyn,
    homogeneousAggregateLiterals: false,
    limits: SOURCE_LIMITS,
  });
  for (const [operator, apply] of Object.entries(ARITHMETIC)) {
    const handler = (left: Operand, right: Operand): number => apply(Number(left), Number(right));
    built.registerOperator(`int ${operator} double: double`, handler);
    built.registerOperator(`double ${operator} int: double`, handler);
  }
  built.registerOperator("double % double: double", ARITHMETIC["%"]);
  // Registering `==` also registers `double == int` and both `!=`.
  built.registerOperator("int == double", (left: bigint, right: number) => Number(left) === right);
  for (const number of ["int", "double"]) {
    built.registerOperator(
      `string + ${number}: string`,
      (left: string, right: Operand) => left + String(right),
    );
    built.registerOperator(
      `${number} + string: string`,
      (left: Operand, right: string) => String(left) + right,
    );
  }
  return built;
};

/**
 * The environment used to parse and evaluate. It declares no variables and
 * reads each one from the evaluation context. Which variables a source may
 * read was already enforced when the source was validated.
 *
 * Context variables are dynamic. A payload is loosely shaped, and a plain
 * JSON number stays a number this way instead of needing a BigInt literal to
 * compare against.
 */
const environment = buildEnvironment(true);

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

/**
 * The variables one evaluation reads, by name: `event` for an expression over
 * one event, or `inputs` and `steps` for one inside a run.
 */
export type EvaluationContext = Readonly<Record<string, unknown>>;

/** The variables each scope declares. All are `dyn`, as in the evaluation environment. */
const SCOPE_VARIABLES: Record<ExpressionScope, ReadonlyArray<string>> = {
  event: ["event"],
  run: ["inputs", "steps"],
};

/**
 * Builds an environment that declares only the variables of one scope, so
 * validation rejects a source that reads any other variable. It has the same
 * limits and operators as evaluation.
 */
const buildScopedEnvironment = (scope: ExpressionScope): Environment =>
  SCOPE_VARIABLES[scope].reduce(
    (built, variable) => built.registerVariable(variable, "dyn"),
    buildEnvironment(false),
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

/**
 * Returns whether an evaluator error is a read of a key the context does not
 * have. The evaluator marks that error with the code `no_such_key`.
 */
const isMissingKeyFailure = (failure: unknown): boolean =>
  (failure as { readonly code?: unknown } | null)?.code === "no_such_key";

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
  (context: EvaluationContext): unknown;
}

/**
 * The compiled program, for a caller that evaluates one source against many
 * contexts and does not want it read again for each of them. It only parses:
 * it does not type-check the source the way `validateExpression` does. The guard
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
export const validateExpression = (
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
export const validateCondition = (
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
export const validateTemplate = (template: string): Effect.Effect<void, ExpressionError> =>
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
          validateExpression(expression.source, "run"),
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
  context: EvaluationContext,
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
          ...(isMissingKeyFailure(failure) ? { isUnresolvedReference: true } : {}),
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

/**
 * Evaluates a condition of a step or an edge against a run's context
 * (`inputs` and `steps`), and returns whether it holds. Fails with
 * `ExpressionError` if the condition cannot be evaluated, or if it gives
 * anything but true or false. A condition whose type is only known at run
 * time passes validation when it is saved, so this is where a wrong type is
 * caught.
 */
export const evaluateCondition = (
  source: string,
  context: EvaluationContext,
): Effect.Effect<boolean, ExpressionError> =>
  Effect.flatMap(evaluateExpression(source, context), (value) =>
    typeof value === "boolean"
      ? Effect.succeed(value)
      : Effect.fail(
          new ExpressionError({
            message: `that expression gave ${describeValueKind(value)}, but a condition must give true or false`,
          }),
        ),
  );

/** Returns the kind of a value an expression gave, in words, such as "a string". */
const describeValueKind = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
    case "bigint":
      return "a number";
    case "object":
      return "a map";
    default:
      return "a value that is not true or false";
  }
};

/**
 * Converts a value an expression returned into JSON. Returns `undefined` when
 * the value has no JSON form.
 *
 * The evaluator returns an integer as a `BigInt`, for an integer literal and
 * for what a function such as `size` returns, even inside a list or a map.
 * `JSON.stringify` rejects a `BigInt`, and a schema for a number does not
 * accept one, so an integer becomes a number here. An integer too large to be
 * an exact number has no JSON form. So have bytes, durations, timestamps and
 * the other values that are not plain data.
 */
const convertToJson = (value: unknown): unknown => {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "bigint":
      return Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
    case "object": {
      if (value === null) return null;
      if (Array.isArray(value)) {
        const items = value.map(convertToJson);
        return items.includes(undefined) ? undefined : items;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
      const entries = Object.entries(value).map(([key, item]) => [key, convertToJson(item)]);
      return entries.some(([, item]) => item === undefined)
        ? undefined
        : Object.fromEntries(entries);
    }
    default:
      return undefined;
  }
};

/**
 * The end of the message for an expression whose value has no JSON form. It
 * follows a phrase that names the expression.
 */
const NOT_JSON_REFUSAL =
  "returns a value that cannot be written as JSON, such as bytes, a duration, a timestamp, an integer too large for a JSON number, or the infinity or the NaN that dividing a decimal by zero gives (as in x / 0.0 or x % 0.0). Convert it with string(), or change the expression.";

/**
 * Renders a template against a run's context (`inputs` and `steps`). Fails
 * with `ExpressionError` if an expression cannot be evaluated, or returns a
 * value with no JSON form.
 *
 * A template that is exactly one `{{ expr }}`, with no other text, renders to
 * the expression's value with its own JSON type. So `{{ inputs.count }}`
 * renders to the number 3, and can fill a field that takes a number. Any
 * other template renders to text: each expression is replaced by its value,
 * a string as it is and any other value as JSON.
 */
export const renderTemplate = (
  template: string,
  context: EvaluationContext,
): Effect.Effect<unknown, ExpressionError> =>
  Effect.gen(function* () {
    const parsed = parseTemplateExpressions(template);
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(
        new ExpressionError({
          message: `The {{ at character ${String(countCharactersBefore(template, parsed.failure) + 1)} has no closing }}.`,
        }),
      );
    }
    const values: Array<unknown> = [];
    for (const expression of parsed.success) {
      const describeSite = (): string =>
        `The expression that starts with the {{ at character ${String(countCharactersBefore(template, expression.offset) + 1)}`;
      const value = yield* Effect.mapError(
        evaluateExpression(expression.source, context),
        (error) => new ExpressionError({ message: `${describeSite()}: ${error.message}` }),
      );
      const json = convertToJson(value);
      if (json === undefined) {
        return yield* Effect.fail(
          new ExpressionError({
            message: `${describeSite()} ${NOT_JSON_REFUSAL}`,
          }),
        );
      }
      values.push(json);
    }
    /** Returns the index just past the `}}` that closes an expression. */
    const findEnd = (expression: TemplateExpression): number =>
      expression.offset + TEMPLATE_OPEN.length + expression.source.length + TEMPLATE_CLOSE.length;
    const [first] = parsed.success;
    if (parsed.success.length === 1 && first!.offset === 0 && findEnd(first!) === template.length) {
      return values[0];
    }
    let rendered = "";
    let from = 0;
    parsed.success.forEach((expression, index) => {
      const value = values[index];
      rendered +=
        template.slice(from, expression.offset) +
        (typeof value === "string" ? value : JSON.stringify(value));
      from = findEnd(expression);
    });
    return rendered + template.slice(from);
  });

/**
 * Renders every template in a JSON value, at any depth: each string that is a
 * template (see `isTemplate`) is replaced by what `renderTemplate` renders it
 * to. Every other value is returned as it is. Fails with `ExpressionError` for
 * the first template that cannot be rendered; the message names the template's
 * path in the value, such as `labels.0`.
 */
export const renderTemplates = (
  value: unknown,
  context: EvaluationContext,
  path: ReadonlyArray<string> = [],
): Effect.Effect<unknown, ExpressionError> => {
  if (typeof value === "string") {
    return isTemplate(value)
      ? Effect.mapError(
          renderTemplate(value, context),
          (error) =>
            new ExpressionError({
              message: `The template in ${path.length === 0 ? "the value" : path.join(".")} could not be rendered. ${error.message}`,
            }),
        )
      : Effect.succeed(value);
  }
  if (Array.isArray(value)) {
    return Effect.forEach(value, (item, index) =>
      renderTemplates(item, context, [...path, String(index)]),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Effect.map(
      Effect.forEach(Object.entries(value), ([key, item]) =>
        Effect.map(renderTemplates(item, context, [...path, key]), (rendered) => [key, rendered]),
      ),
      Object.fromEntries,
    );
  }
  return Effect.succeed(value);
};

/**
 * Evaluates a trigger's mapping against an event's context (`event`), and
 * returns each name with the JSON value of its expression. A start trigger
 * maps the run's inputs and a signal trigger maps its outputs; `mappingTarget`
 * says which, for the error message. Fails with `ExpressionError` for the first
 * expression that cannot be evaluated or returns a value with no JSON form;
 * the message names the input or the output.
 */
export const evaluateMapping = (
  mapping: Readonly<Record<string, string>>,
  context: EvaluationContext,
  mappingTarget: "input" | "output",
): Effect.Effect<Record<string, unknown>, ExpressionError> =>
  Effect.map(
    Effect.forEach(Object.entries(mapping), ([name, source]) =>
      Effect.gen(function* () {
        const describeSite = (): string => `The expression for the ${mappingTarget} ${name}`;
        const value = yield* Effect.mapError(
          evaluateExpression(source, context),
          (error) => new ExpressionError({ message: `${describeSite()}: ${error.message}` }),
        );
        const json = convertToJson(value);
        if (json === undefined) {
          return yield* Effect.fail(
            new ExpressionError({ message: `${describeSite()} ${NOT_JSON_REFUSAL}` }),
          );
        }
        return [name, json] as const;
      }),
    ),
    (entries) => Object.fromEntries(entries),
  );
