/**
 * Tests how a completed agent step's output becomes the outcome the Tracking
 * pane draws: the text cut, the field labels and order, the value kinds and
 * the limits.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TRACKING_OUTPUT_FIELDS,
  MAX_TRACKING_OUTPUT_TEXT,
  MAX_TRACKING_OUTPUT_VALUE,
} from "@hercule/contract";
import { cutText, shapeTrackingOutcome, type AgentStepResult } from "./tracking-outcome";

const SESSION = "0199e0e7-0007-7000-8000-00000000000a";

const buildStep = (
  output: AgentStepResult["output"],
  outputSchema?: AgentStepResult["outputSchema"],
): AgentStepResult => ({ stepName: "Review", sessionId: SESSION, output, outputSchema });

/** Returns the fields of a fields outcome, and fails the test for any other outcome. */
const readFields = (outcome: ReturnType<typeof shapeTrackingOutcome>) => {
  if (outcome?.kind !== "fields") throw new Error("expected a fields outcome");
  return outcome.fields;
};

describe("shapeTrackingOutcome for a step with no output schema", () => {
  it("returns the step's text, with the step's name and session", () => {
    expect(
      shapeTrackingOutcome(buildStep({ text: "Looks good.", exitStatus: "completed" })),
    ).toEqual({
      kind: "text",
      stepName: "Review",
      sessionId: SESSION,
      text: "Looks good.",
    });
  });

  it("leaves the session out when the step has none", () => {
    const outcome = shapeTrackingOutcome({ ...buildStep({ text: "Hi" }), sessionId: undefined });

    expect(outcome).toEqual({ kind: "text", stepName: "Review", text: "Hi" });
  });

  it("trims the text", () => {
    expect(shapeTrackingOutcome(buildStep({ text: "\n  Done.  \n" }))).toMatchObject({
      text: "Done.",
    });
  });

  it.each([
    ["an empty output", {}],
    ["an output with no text", { exitStatus: "completed" }],
    ["a text that is not a string", { text: 42 }],
    ["a blank text", { text: "  \n " }],
    ["a null output", null],
    ["an output that is a string", "plain"],
    ["an output that is an array", ["a"]],
  ])("returns nothing for %s", (_, output) => {
    expect(shapeTrackingOutcome(buildStep(output))).toBeUndefined();
  });

  it("cuts a long text and ends it with an ellipsis", () => {
    const outcome = shapeTrackingOutcome(buildStep({ text: "word ".repeat(1000) }));

    expect(outcome).toMatchObject({ kind: "text" });
    const text = (outcome as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(MAX_TRACKING_OUTPUT_TEXT + 1);
    expect(text.endsWith("word…")).toBe(true);
  });
});

describe("cutText", () => {
  it("returns a text that fits unchanged", () => {
    expect(cutText("a\n\nb", 10)).toBe("a\n\nb");
    expect(cutText("x".repeat(10), 10)).toBe("x".repeat(10));
  });

  it("cuts at the last paragraph break within the limit, before a line break or a word", () => {
    expect(cutText("first line\nsecond line\n\nthird paragraph runs on", 40)).toBe(
      "first line\nsecond line…",
    );
  });

  it("cuts at the last line break when there is no paragraph break", () => {
    expect(cutText("- one\n- two\n- three four five six", 25)).toBe("- one\n- two…");
  });

  it("cuts at the last word when there is no break", () => {
    expect(cutText("alpha beta gamma delta", 14)).toBe("alpha beta…");
  });

  it("cuts at the limit when there is nothing to break on", () => {
    expect(cutText("x".repeat(30), 10)).toBe("x".repeat(10) + "…");
  });

  it("does not split a surrogate pair", () => {
    const cut = cutText("a" + "😀".repeat(10), 4);

    expect(cut).toBe("a😀…");
  });

  it("ignores a break at the very start", () => {
    expect(cutText("\nabcdefghijklmnop", 8)).toBe("\nabcdefg…");
  });
});

describe("shapeTrackingOutcome for a step with an output schema", () => {
  const SCHEMA = {
    type: "object",
    properties: {
      verdict: { type: "string", title: "Verdict" },
      score: { type: "number" },
      blocking: { type: "boolean", title: "Blocking" },
      notes: { type: "array" },
      detail: { type: "object" },
      reviewer: { type: ["string", "null"], title: "" },
    },
  };

  it("lists the fields in the schema's property order, labelled by title, else by name", () => {
    const outcome = shapeTrackingOutcome(
      buildStep(
        {
          reviewer: null,
          detail: { a: 1, b: 2 },
          notes: ["x", "y", "z"],
          blocking: false,
          score: 0.5,
          verdict: "Approve",
        },
        SCHEMA,
      ),
    );

    expect(outcome).toEqual({
      kind: "fields",
      stepName: "Review",
      sessionId: SESSION,
      fields: [
        { label: "Verdict", value: "Approve" },
        { label: "score", value: 0.5 },
        { label: "Blocking", value: false },
        { label: "notes", value: { items: 3 } },
        { label: "detail", value: { fields: 2 } },
        { label: "reviewer", value: null },
      ],
    });
  });

  it("skips a property the output does not hold", () => {
    const outcome = shapeTrackingOutcome(buildStep({ verdict: "Approve" }, SCHEMA));

    expect(outcome).toMatchObject({ fields: [{ label: "Verdict", value: "Approve" }] });
  });

  it("uses the output's own order for a schema that lists no properties", () => {
    const outcome = shapeTrackingOutcome(buildStep({ b: 1, a: "x" }, { type: "object" }));

    expect(outcome).toMatchObject({
      fields: [
        { label: "b", value: 1 },
        { label: "a", value: "x" },
      ],
    });
  });

  it("cuts a long string value", () => {
    const fields = readFields(
      shapeTrackingOutcome(buildStep({ verdict: "word ".repeat(200) }, SCHEMA)),
    );

    const value = fields[0]!.value as string;
    expect(value.length).toBeLessThanOrEqual(MAX_TRACKING_OUTPUT_VALUE + 1);
    expect(value.endsWith("…")).toBe(true);
  });

  it("lists at most the field limit, from the schema's first properties", () => {
    const names = Array.from({ length: MAX_TRACKING_OUTPUT_FIELDS + 5 }, (_, n) => `f${String(n)}`);
    const schema = { properties: Object.fromEntries(names.map((name) => [name, {}])) };
    const output = Object.fromEntries(names.map((name, n) => [name, n]));

    const fields = readFields(shapeTrackingOutcome(buildStep(output, schema)));

    expect(fields.map((field) => field.label)).toEqual(names.slice(0, MAX_TRACKING_OUTPUT_FIELDS));
  });

  it.each([
    ["an output that is null", null],
    ["an output that is not an object", "text"],
    ["an output with none of the schema's properties", { other: 1 }],
    ["an empty output", {}],
  ])("returns nothing for %s", (_, output) => {
    expect(shapeTrackingOutcome(buildStep(output, SCHEMA))).toBeUndefined();
  });

  it("does not read a text field of a step that has a schema as the step's text", () => {
    const outcome = shapeTrackingOutcome(buildStep({ text: "A field named text" }, SCHEMA));

    expect(outcome).toBeUndefined();
  });
});
