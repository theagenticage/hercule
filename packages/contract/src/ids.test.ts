import { describe, expect, it } from "vitest";
import { Cause, Effect, Schema } from "effect";
import { ExternalRef, Id, issuesOf } from "./index";

const decode = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(ExternalRef)(input))._tag;

describe("the External Ref grammar", () => {
  it("takes a fully-qualified ref, identity punctuation and all", () => {
    expect(decode("github:issue:owner/repo#42")).toBe("Success");
  });

  it("refuses an uppercase system, a missing identity, and whitespace", () => {
    // Two spellings of one system would be two refs, and the duplicate-signal
    // query the ref exists for would stop finding the task it already made.
    expect(decode("GitHub:issue:x")).toBe("Failure");
    expect(decode("github:issue")).toBe("Failure");
    expect(decode("github:issue:a b")).toBe("Failure");
  });
});

describe("the id grammar", () => {
  it("says what an id looks like, and not the pattern that checks it", () => {
    const failed = Schema.decodeUnknownExit(Id)("1234");
    expect(failed._tag).toBe("Failure");
    if (failed._tag !== "Failure") return;
    const error = Cause.squash(failed.cause) as Schema.SchemaError;
    expect(issuesOf(error)).toEqual([
      { path: [], message: "Expected a canonical lowercase UUIDv7" },
    ]);
  });
});
