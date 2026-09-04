import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { ExternalRef } from "../index";

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
