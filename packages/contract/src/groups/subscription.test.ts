/**
 * The shorthand a person and an agent type: `hercule subscription create
 * run:r_3`, or a bare External Ref. The schema is the whole of the parsing, in
 * both directions, so a command line and a stored target can never disagree
 * about what a token means.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { SubscriptionTargetFromShorthand } from "./subscription";

const decode = (input: string): Exit.Exit<unknown, unknown> =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(SubscriptionTargetFromShorthand)(input));

const decodeOrFail = (input: string): unknown => {
  const exit = decode(input);
  if (Exit.isFailure(exit)) throw new Error(`${input} did not decode: ${Cause.pretty(exit.cause)}`);
  return exit.value;
};

/** The text a refusal carries, or a thrown report that it did not refuse. */
const readRefusal = (input: string): string => {
  const exit = decode(input);
  if (Exit.isSuccess(exit)) throw new Error(`${input} decoded to ${JSON.stringify(exit.value)}`);
  return Cause.pretty(exit.cause);
};

const encodeTarget = (target: unknown): unknown =>
  Effect.runSync(Schema.encodeUnknownEffect(SubscriptionTargetFromShorthand)(target));

describe("SubscriptionTargetFromShorthand", () => {
  it("decodes each prefixed form into its union member", () => {
    expect(decodeOrFail("run:r_3")).toEqual({ kind: "run", runId: "r_3" });
    expect(decodeOrFail("session:s_12")).toEqual({ kind: "session", sessionId: "s_12" });
    expect(decodeOrFail("request:pr_7")).toEqual({ kind: "request", requestId: "pr_7" });
  });

  it("takes a bare External Ref as a ref target", () => {
    expect(decodeOrFail("github:pr:o/r#87")).toEqual({ kind: "ref", ref: "github:pr:o/r#87" });
  });

  it("encodes every member back to the string it was written as", () => {
    for (const shorthand of ["run:r_3", "session:s_12", "request:pr_7", "github:pr:o/r#87"]) {
      expect(encodeTarget(decodeOrFail(shorthand)), shorthand).toBe(shorthand);
    }
  });

  it("refuses a token that is none of the four forms, and names all four", () => {
    for (const nonsense of ["nonsense", "run:"]) {
      const message = readRefusal(nonsense);
      for (const form of ["run:", "session:", "request:", "ref"]) {
        expect(message, `${nonsense} -> ${message}`).toContain(form);
      }
    }
  });
});
