/**
 * Tests how a completed agent step's output becomes the output the Tracking
 * pane draws: the text cut, the field labels and order, the value kinds and
 * the limits.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TRACKING_OUTPUT_FIELDS,
  MAX_TRACKING_OUTPUT_LABEL,
  MAX_TRACKING_OUTPUT_TEXT,
  MAX_TRACKING_OUTPUT_VALUE,
  MAX_TRACKING_STEP_NAME,
} from "@hercule/contract";
import { shapeTrackingOutput, type CompletedAgentStep } from "./tracking-output";

const SESSION = "0199e0e7-0007-7000-8000-00000000000a";

const buildStep = (
  output: CompletedAgentStep["output"],
  outputSchema?: CompletedAgentStep["outputSchema"],
): CompletedAgentStep => ({ stepName: "Review", sessionId: SESSION, output, outputSchema });

/** Returns the fields of a fields output, and fails the test for any other output. */
const readFields = (output: ReturnType<typeof shapeTrackingOutput>) => {
  if (output?.kind !== "fields") throw new Error("expected a fields output");
  return output.fields;
};

describe("shapeTrackingOutput for a step with no output schema", () => {
  it("returns the step's text, with the step's name and session", () => {
    expect(
      shapeTrackingOutput(buildStep({ text: "Looks good.", exitStatus: "completed" })),
    ).toEqual({
      kind: "text",
      stepName: "Review",
      sessionId: SESSION,
      text: "Looks good.",
    });
  });

  it("leaves the session out when the step has none", () => {
    const output = shapeTrackingOutput({ ...buildStep({ text: "Hi" }), sessionId: undefined });

    expect(output).toEqual({ kind: "text", stepName: "Review", text: "Hi" });
  });

  it.each([
    ["text", undefined],
    ["fields", { properties: { verdict: {} } }],
  ])("cuts a step name that is too long, for a %s output", (_, outputSchema) => {
    const stepName = "Review the change ".repeat(5000);

    const output = shapeTrackingOutput({
      ...buildStep({ text: "Done", verdict: "Approve" }, outputSchema),
      stepName,
    });

    const cutName = output!.stepName;
    expect(cutName.length).toBeLessThanOrEqual(MAX_TRACKING_STEP_NAME);
    expect(cutName.startsWith("Review the change")).toBe(true);
    expect(cutName.endsWith("…")).toBe(true);
  });

  it("keeps a step name that fits", () => {
    const stepName = "x".repeat(MAX_TRACKING_STEP_NAME);

    expect(shapeTrackingOutput({ ...buildStep({ text: "Hi" }), stepName })).toMatchObject({
      stepName,
    });
  });

  it("trims the text", () => {
    expect(shapeTrackingOutput(buildStep({ text: "\n  Done.  \n" }))).toMatchObject({
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
    expect(shapeTrackingOutput(buildStep(output))).toBeUndefined();
  });

  it("cuts a long text and ends it with an ellipsis", () => {
    const output = shapeTrackingOutput(buildStep({ text: "word ".repeat(1000) }));

    expect(output).toMatchObject({ kind: "text" });
    const text = (output as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(MAX_TRACKING_OUTPUT_TEXT);
    expect(text.endsWith("word…")).toBe(true);
  });
});

describe("shapeTrackingOutput for a step with an output schema", () => {
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
    const output = shapeTrackingOutput(
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

    expect(output).toEqual({
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
    const output = shapeTrackingOutput(buildStep({ verdict: "Approve" }, SCHEMA));

    expect(output).toMatchObject({ fields: [{ label: "Verdict", value: "Approve" }] });
  });

  it("uses the output's own order for a schema that lists no properties", () => {
    const output = shapeTrackingOutput(buildStep({ b: 1, a: "x" }, { type: "object" }));

    expect(output).toMatchObject({
      fields: [
        { label: "b", value: 1 },
        { label: "a", value: "x" },
      ],
    });
  });

  it("cuts a long string value", () => {
    const fields = readFields(
      shapeTrackingOutput(buildStep({ verdict: "word ".repeat(200) }, SCHEMA)),
    );

    const value = fields[0]!.value as string;
    expect(value.length).toBeLessThanOrEqual(MAX_TRACKING_OUTPUT_VALUE);
    expect(value.endsWith("…")).toBe(true);
  });

  it("cuts a long title, and a long property name when the schema has no properties", () => {
    const title = "A very long title ".repeat(100);
    const key = "k".repeat(100_000);

    const titled = readFields(
      shapeTrackingOutput(buildStep({ verdict: 1 }, { properties: { verdict: { title } } })),
    );
    const named = readFields(shapeTrackingOutput(buildStep({ [key]: 1 }, { type: "object" })));

    for (const label of [titled[0]!.label, named[0]!.label]) {
      expect(label.length).toBeLessThanOrEqual(MAX_TRACKING_OUTPUT_LABEL);
      expect(label.endsWith("…")).toBe(true);
    }
    expect(titled[0]!.label.startsWith("A very long title")).toBe(true);
  });

  it("keeps a label that fits", () => {
    const label = "x".repeat(MAX_TRACKING_OUTPUT_LABEL);

    const fields = readFields(shapeTrackingOutput(buildStep({ [label]: 1 }, { type: "object" })));

    expect(fields[0]!.label).toBe(label);
  });

  it("lists at most the field limit, from the schema's first properties", () => {
    const names = Array.from({ length: MAX_TRACKING_OUTPUT_FIELDS + 5 }, (_, n) => `f${String(n)}`);
    const schema = { properties: Object.fromEntries(names.map((name) => [name, {}])) };
    const output = Object.fromEntries(names.map((name, n) => [name, n]));

    const fields = readFields(shapeTrackingOutput(buildStep(output, schema)));

    expect(fields.map((field) => field.label)).toEqual(names.slice(0, MAX_TRACKING_OUTPUT_FIELDS));
  });

  it.each([
    ["an output that is null", null],
    ["an output that is not an object", "text"],
    ["an output with none of the schema's properties", { other: 1 }],
    ["an empty output", {}],
  ])("returns nothing for %s", (_, output) => {
    expect(shapeTrackingOutput(buildStep(output, SCHEMA))).toBeUndefined();
  });

  it("does not read a text field of a step that has a schema as the step's text", () => {
    const output = shapeTrackingOutput(buildStep({ text: "A field named text" }, SCHEMA));

    expect(output).toBeUndefined();
  });
});
