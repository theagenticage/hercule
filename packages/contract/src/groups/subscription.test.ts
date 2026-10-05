/**
 * Tests the shorthand a person or an agent types: `hercule subscription create
 * run:<run id>`, or a bare External Ref. The schema does all of the parsing and
 * formatting, so a command line and a stored target can never disagree about
 * what a token means.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import {
  SubscriptionCreateInput,
  SubscriptionHolderFromShorthand,
  SubscriptionTargetFromShorthand,
} from "./subscription";

const decode = (input: string): Exit.Exit<unknown, unknown> =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(SubscriptionTargetFromShorthand)(input));

const decodeOrFail = (input: string): unknown => {
  const exit = decode(input);
  if (Exit.isFailure(exit)) throw new Error(`${input} did not decode: ${Cause.pretty(exit.cause)}`);
  return exit.value;
};

/** Returns the error text of a failed decode. Throws when the input decodes. */
const readRefusal = (input: string): string => {
  const exit = decode(input);
  if (Exit.isSuccess(exit)) throw new Error(`${input} decoded to ${JSON.stringify(exit.value)}`);
  return Cause.pretty(exit.cause);
};

/** A run id, which is a UUIDv7 like every id the controller mints. */
const RUN_ID = "0199f0b7-0000-7000-8000-00000000a001";

const encodeTarget = (target: unknown): unknown =>
  Effect.runSync(Schema.encodeUnknownEffect(SubscriptionTargetFromShorthand)(target));

describe("SubscriptionTargetFromShorthand", () => {
  it("decodes each prefixed form into its union member", () => {
    expect(decodeOrFail(`run:${RUN_ID}`)).toEqual({ kind: "run", runId: RUN_ID });
    expect(decodeOrFail("session:s_12")).toEqual({ kind: "session", sessionId: "s_12" });
    expect(decodeOrFail("request:pr_7")).toEqual({ kind: "request", requestId: "pr_7" });
  });

  it("takes a bare External Ref as a ref target", () => {
    expect(decodeOrFail("github:pr:o/r#87")).toEqual({ kind: "ref", ref: "github:pr:o/r#87" });
  });

  it("encodes every member back to the string it was written as", () => {
    for (const shorthand of [`run:${RUN_ID}`, "session:s_12", "request:pr_7", "github:pr:o/r#87"]) {
      expect(encodeTarget(decodeOrFail(shorthand)), shorthand).toBe(shorthand);
    }
  });

  it("rejects a token that matches none of the four forms, and lists all four", () => {
    for (const nonsense of ["nonsense", "run:"]) {
      const message = readRefusal(nonsense);
      for (const form of ["run:", "session:", "request:", "ref"]) {
        expect(message, `${nonsense} -> ${message}`).toContain(form);
      }
    }
  });

  it("rejects a run target whose id is not a run id, because runs exist and their ids are UUIDs", () => {
    expect(readRefusal("run:r_3")).toMatch(/UUID[\s\S]*runId/);
  });
});

describe("SubscriptionTarget as subscription.create reads it", () => {
  it("refuses a signal trigger target, because only a run opens a subscription on its own signal trigger", () => {
    const create = Effect.runSyncExit(
      Schema.decodeUnknownEffect(SubscriptionCreateInput)({
        target: { kind: "signal", triggerId: "approved" },
      }),
    );
    expect(Exit.isFailure(create)).toBe(true);
    expect(readRefusal("signal:approved")).toContain("not a valid Subscription Target");
  });
});

describe("SubscriptionHolderFromShorthand", () => {
  const decodeHolder = (input: string): Exit.Exit<unknown, unknown> =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(SubscriptionHolderFromShorthand)(input));

  it("decodes a session holder and a run holder", () => {
    expect(decodeHolder(`session:${RUN_ID}`)).toEqual(
      Exit.succeed({ kind: "session", id: RUN_ID }),
    );
    expect(decodeHolder(`run:${RUN_ID}`)).toEqual(Exit.succeed({ kind: "run", id: RUN_ID }));
  });

  it("refuses any other prefix, and names both forms it takes", () => {
    const exit = decodeHolder(`agent:${RUN_ID}`);
    if (Exit.isSuccess(exit)) throw new Error("agent: decoded as a holder");
    expect(Cause.pretty(exit.cause)).toContain("write session:<session id> or run:<run id>");
  });
});
