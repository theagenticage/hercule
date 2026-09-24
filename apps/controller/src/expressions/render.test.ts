/**
 * How a run renders the templates in a step's params: a template that is one
 * expression keeps the expression's type, any other template becomes text,
 * and every string in the params is rendered, at any depth.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { evaluateExpression, renderTemplate, renderTemplates } from "./index";

const CONTEXT = {
  inputs: { count: 3, price: 2.5, first: 0, title: "Fix login", labels: ["bug"], urgent: true },
  steps: { create: { output: { id: "t_1", items: [1, 2] } } },
};

const render = (template: string): unknown => Effect.runSync(renderTemplate(template, CONTEXT));

/** Returns the message a render failed with. */
const readFailure = (effect: Effect.Effect<unknown, { readonly message: string }>): string => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit))
    throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`);
  return Option.getOrThrow(Cause.findErrorOption(exit.cause)).message;
};

describe("renderTemplate", () => {
  it("keeps the JSON type of a template that is exactly one expression", () => {
    expect(render("{{ inputs.count }}")).toBe(3);
    expect(render("{{ inputs.urgent }}")).toBe(true);
    expect(render("{{ inputs.labels }}")).toEqual(["bug"]);
    expect(render("{{ steps.create.output.id }}")).toBe("t_1");
  });

  it("converts the integers the evaluator returns as BigInt to numbers, also inside lists and maps", () => {
    expect(render("{{ size(steps.create.output.items) }}")).toBe(2);
    expect(render("{{ [1, 2] }}")).toEqual([1, 2]);
    expect(render("{{ {'a': 1} }}")).toEqual({ a: 1 });
  });

  it("renders any other template as text, with non-string values as JSON", () => {
    expect(render("Fix {{ inputs.count }} bugs")).toBe("Fix 3 bugs");
    expect(render("{{ inputs.title }}: {{ inputs.labels }}")).toBe('Fix login: ["bug"]');
    expect(render(" {{ inputs.count }}")).toBe(" 3");
    expect(render("{{ size(steps.create.output.items) }} items")).toBe("2 items");
  });

  it("renders a literal {{ written as an expression", () => {
    expect(render("{{ '{{' }} not a template")).toBe("{{ not a template");
  });

  it("fails when an expression reads something that does not exist", () => {
    expect(readFailure(renderTemplate("{{ steps.missing.output.id }}", CONTEXT))).toMatch(
      /character 1/,
    );
  });

  it("fails when a value has no JSON form", () => {
    expect(readFailure(renderTemplate("{{ b'abc' }}", CONTEXT))).toMatch(
      /cannot be written as JSON/,
    );
    expect(readFailure(renderTemplate("{{ 9223372036854775807 }}", CONTEXT))).toMatch(
      /cannot be written as JSON/,
    );
  });

  it("fails, naming infinity and NaN, when a decimal is divided by zero", () => {
    expect(readFailure(renderTemplate("{{ inputs.price / 0.0 }}", CONTEXT))).toMatch(
      /infinity or the NaN/,
    );
    expect(readFailure(renderTemplate("{{ inputs.price % 0.0 }}", CONTEXT))).toMatch(
      /infinity or the NaN/,
    );
  });
});

describe("renderTemplates", () => {
  it("renders every template in the params at any depth and leaves other values alone", () => {
    expect(
      Effect.runSync(
        renderTemplates(
          {
            title: "{{ inputs.title }}",
            priority: "high",
            count: 7,
            provenance: [{ ref: "run {{ inputs.count }}", note: null }],
          },
          CONTEXT,
        ),
      ),
    ).toEqual({
      title: "Fix login",
      priority: "high",
      count: 7,
      provenance: [{ ref: "run 3", note: null }],
    });
  });

  it("names the path of the template that failed", () => {
    expect(
      readFailure(renderTemplates({ provenance: [{ ref: "{{ steps.gone.output }}" }] }, CONTEXT)),
    ).toMatch(/provenance\.0\.ref/);
  });
});

/**
 * Standard CEL keeps whole numbers (int) and decimals (double) apart, and a
 * number read from the context is always a double. These tests pin the
 * extensions that let an author mix the two, and a number with a string,
 * without thinking about types.
 */
describe("numbers in a template, whatever their CEL type", () => {
  it("adds, subtracts, multiplies and divides a number read from the context and a literal", () => {
    expect(render("{{ inputs.count + 1 }}")).toBe(4);
    expect(render("{{ 1 + inputs.count }}")).toBe(4);
    expect(render("{{ inputs.count - 1 }}")).toBe(2);
    expect(render("{{ inputs.price * 2 }}")).toBe(5);
    expect(render("{{ inputs.count / 2 }}")).toBe(1.5);
    expect(render("{{ inputs.count % 2 }}")).toBe(1);
    expect(render("{{ size(inputs.labels) + 0.5 }}")).toBe(1.5);
  });

  it("writes a whole decimal as a JSON integer", () => {
    expect(JSON.stringify(render("{{ inputs.price * 2 }}"))).toBe("5");
    expect(render("{{ inputs.price * 2 }} items")).toBe("5 items");
  });

  it("keeps two whole numbers whole, so dividing two literals still drops the remainder", () => {
    expect(Effect.runSync(evaluateExpression("1 + 2", CONTEXT))).toBe(3n);
    expect(render("{{ 7 / 2 }}")).toBe(3);
    expect(render("{{ 7 / 2.0 }}")).toBe(3.5);
  });

  it("compares a whole number and a decimal by value", () => {
    expect(render("{{ inputs.count == 3 }}")).toBe(true);
    expect(render("{{ inputs.count < 10 }}")).toBe(true);
    expect(render("{{ inputs.count + 1 > 3 }}")).toBe(true);
    expect(render("{{ 3 == 3.0 }}")).toBe(true);
    expect(render("{{ 3.0 != 3 }}")).toBe(false);
    expect(render("{{ size(inputs.labels) == 1.0 }}")).toBe(true);
  });

  it("joins a string and a number, in either order, writing a whole decimal without .0", () => {
    expect(render("{{ 'count: ' + inputs.count }}")).toBe("count: 3");
    expect(render("{{ inputs.count + ' left' }}")).toBe("3 left");
    expect(render("{{ 'price ' + inputs.price }}")).toBe("price 2.5");
    expect(render("{{ 'step ' + 1 }}")).toBe("step 1");
    expect(render("{{ 'step ' + 2.0 }}")).toBe("step 2");
  });

  it("indexes a list by a number read from the context", () => {
    expect(render("{{ inputs.labels[inputs.first] }}")).toBe("bug");
  });

  it("accepts a list or a map literal that mixes whole numbers and other values", () => {
    expect(render("{{ [1, inputs.price] }}")).toEqual([1, 2.5]);
    expect(render("{{ {'low': 1, 'high': 2.5} }}")).toEqual({ low: 1, high: 2.5 });
  });
});
