/**
 * The one place a harness's answer becomes a `StructuredResult`. Every adapter
 * hands this function what its harness produced - a value, or the reason there
 * is none - and this decides whether the session answered its schema.
 */
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_LENGTH, type OutputSchema } from "@hercule/protocol";
import { judgeAnswer } from "./structured-result";

/**
 * Inside the subset `lintOutputSchema` accepts: a closed object, every property
 * required, one string enum. Small on purpose - what is tested here is the
 * verdict and what it says, not the validator's coverage of draft-07.
 */
const SCHEMA: OutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "summary"],
  properties: {
    verdict: { type: "string", enum: ["accept", "dismiss"] },
    confidence: { type: "number" },
    summary: { type: "string" },
  },
};

const VALID = { verdict: "accept", confidence: 0.9, summary: "a typo fix" };

describe("a value a harness produced under an output schema", () => {
  it("is the result itself when it satisfies the schema", () => {
    expect(judgeAnswer(SCHEMA, { value: VALID })).toEqual({
      outcome: "ok",
      value: VALID,
    });
  });

  it("is a schema failure naming the field whose type is wrong", () => {
    expect(judgeAnswer(SCHEMA, { value: { ...VALID, confidence: "high" } })).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("confidence") as string,
    });
  });

  it("is a schema failure naming the required key that is missing", () => {
    expect(judgeAnswer(SCHEMA, { value: { verdict: "accept", confidence: 0.9 } })).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("summary") as string,
    });
  });

  it("is a schema failure naming the key the closed object does not allow", () => {
    expect(judgeAnswer(SCHEMA, { value: { ...VALID, rationale: "because" } })).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("rationale") as string,
    });
  });

  it("is a schema failure naming the field whose value is outside its enum", () => {
    expect(judgeAnswer(SCHEMA, { value: { ...VALID, verdict: "maybe" } })).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("verdict") as string,
    });
  });
});

describe("a value that broke the schema deep inside itself", () => {
  /** Two levels, so the path a reason names is not the one a root error gives. */
  const NESTED: OutputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["outer"],
    properties: {
      outer: {
        type: "object",
        additionalProperties: false,
        required: ["inner"],
        properties: { inner: { type: "number" } },
      },
    },
  };

  it("is a schema failure naming the path down to the field itself", () => {
    expect(judgeAnswer(NESTED, { value: { outer: { inner: "deep" } } })).toEqual({
      outcome: "schema-failure",
      // Not the enclosing object: "outer does not match schema" leaves a reader
      // to find which field of it is wrong.
      reason: expect.stringContaining("/outer/inner") as string,
    });
  });
});

describe("a schema whose own message is longer than an event may carry", () => {
  /** Four hundred values, so the validator's message runs past the cap. */
  const WORDY: OutputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["choice"],
    properties: {
      choice: {
        type: "string",
        enum: Array.from({ length: 400 }, (_, at) => `choice-number-${at}`),
      },
    },
  };

  it("cuts the reason to what the protocol carries", () => {
    const result = judgeAnswer(WORDY, { value: { choice: "none of them" } });

    expect(result.outcome).toBe("schema-failure");
    expect(result.outcome === "schema-failure" ? result.reason.length : 0).toBe(MAX_MESSAGE_LENGTH);
  });
});

describe("a harness that produced no value at all", () => {
  it("is a schema failure carrying the adapter's own reason, unchanged", () => {
    expect(
      judgeAnswer(SCHEMA, { missing: "the agent settled without calling record_verdict" }),
    ).toEqual({
      outcome: "schema-failure",
      reason: "the agent settled without calling record_verdict",
    });
  });

  it("cuts a reason the protocol would not carry", () => {
    const result = judgeAnswer(SCHEMA, { missing: "x".repeat(5000) });

    expect(result).toEqual({
      outcome: "schema-failure",
      reason: "x".repeat(MAX_MESSAGE_LENGTH),
    });
  });
});
