/**
 * How a run renders the templates in a step's params: a template that is one
 * expression keeps the expression's type, any other template becomes text,
 * and every string in the params is rendered, at any depth.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { renderTemplate, renderTemplates } from "./index";

const CONTEXT = {
  inputs: { count: 3, title: "Fix login", labels: ["bug"], urgent: true },
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
