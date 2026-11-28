/**
 * Tests `judgeAnswer`, the one place a harness's answer becomes a
 * `StructuredResult`. Every adapter passes it what its harness produced (a
 * value, or the reason there is none), and it decides whether the answer
 * satisfies the session's schema.
 */
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_LENGTH, type OutputSchema } from "@hercule/protocol";
import { judgeAnswer } from "./structured-result";

/**
 * A schema within the subset `lintOutputSchema` accepts: a closed object,
 * every property required, one string enum. It is small on purpose: these
 * tests cover the result and its reason, not the validator's coverage of
 * draft-07.
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

describe("checking a harness's value against an output schema", () => {
  it("returns ok with the value when it satisfies the schema", () => {
    expect(judgeAnswer(SCHEMA, { value: VALID })).toEqual({
      outcome: "ok",
      value: VALID,
    });
  });

  it("fails with a reason that names the field whose type is wrong", () => {
    expect(judgeAnswer(SCHEMA, { value: { ...VALID, confidence: "high" } })).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("confidence") as string,
    });
  });

  it("fails with a reason that names the missing required key", () => {
    expect(judgeAnswer(SCHEMA, { value: { verdict: "accept", confidence: 0.9 } })).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("summary") as string,
    });
  });

  it("fails with a reason that names the key the closed object does not allow", () => {
    expect(judgeAnswer(SCHEMA, { value: { ...VALID, rationale: "because" } })).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("rationale") as string,
    });
  });

  it("fails with a reason that names the field whose value is not in its enum", () => {
    expect(judgeAnswer(SCHEMA, { value: { ...VALID, verdict: "maybe" } })).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("verdict") as string,
    });
  });
});

describe("a value with an error in a nested field", () => {
  /** Two levels deep, so the path in the reason differs from the path of an error at the root. */
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

  it("fails with a reason that names the full path to the field", () => {
    expect(judgeAnswer(NESTED, { value: { outer: { inner: "deep" } } })).toEqual({
      outcome: "schema-failure",
      // Name the field, not the enclosing object: "outer does not match schema"
      // would leave the reader to find which field is wrong.
      reason: expect.stringContaining("/outer/inner") as string,
    });
  });
});

describe("a validator message longer than an event allows", () => {
  /** 400 enum values, so the validator's message is longer than the limit. */
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

  it("truncates the reason to the maximum message length", () => {
    const result = judgeAnswer(WORDY, { value: { choice: "none of them" } });

    expect(result.outcome).toBe("schema-failure");
    expect(result.outcome === "schema-failure" ? result.reason.length : 0).toBe(MAX_MESSAGE_LENGTH);
  });
});

describe("a harness that produced no value at all", () => {
  it("fails with the adapter's own reason, unchanged", () => {
    expect(
      judgeAnswer(SCHEMA, { missing: "the agent finished without calling record_verdict" }),
    ).toEqual({
      outcome: "schema-failure",
      reason: "the agent finished without calling record_verdict",
    });
  });

  it("truncates a reason longer than the maximum message length", () => {
    const result = judgeAnswer(SCHEMA, { missing: "x".repeat(5000) });

    expect(result).toEqual({
      outcome: "schema-failure",
      reason: "x".repeat(MAX_MESSAGE_LENGTH),
    });
  });
});
