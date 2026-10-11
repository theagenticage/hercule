import { describe, expect, it } from "vitest";
import { Cause, Effect, Schema } from "effect";
import {
  ExternalRef,
  Id,
  listDecodeIssues,
  readShorthandDecoder,
  SignalSnoozeInput,
  Timestamp,
  TimestampWithOffset,
} from "./index";

const decode = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(ExternalRef)(input))._tag;

describe("the External Ref grammar", () => {
  it("takes a fully-qualified ref, identity punctuation and all", () => {
    expect(decode("github:issue:owner/repo#42")).toBe("Success");
  });

  it("rejects an uppercase system, a missing identity, and whitespace", () => {
    // Two spellings of one system would be two refs, and the duplicate-signal
    // query the ref exists for would stop finding the task it already made.
    expect(decode("GitHub:issue:x")).toBe("Failure");
    expect(decode("github:issue")).toBe("Failure");
    expect(decode("github:issue:a b")).toBe("Failure");
  });
});

describe("the id grammar", () => {
  it("describes an id in words in its error message, instead of showing the regex", () => {
    const failed = Schema.decodeUnknownExit(Id)("1234");
    expect(failed._tag).toBe("Failure");
    if (failed._tag !== "Failure") return;
    const error = Cause.squash(failed.cause) as Schema.SchemaError;
    expect(listDecodeIssues(error)).toEqual([
      { path: [], message: "Expected a canonical lowercase UUIDv7" },
    ]);
  });
});

describe("a timestamp", () => {
  // The exact time with its offset is a shorthand built on a timestamp, and
  // marking it must not make every timestamp field take an offset time.
  it("is not a shorthand itself", () => {
    expect(readShorthandDecoder(Timestamp)).toBeUndefined();
  });
});

describe("an exact time with its offset", () => {
  const decode = Schema.decodeUnknownExit(TimestampWithOffset);
  const decodeToUtc = (text: string) => {
    const decoded = decode(text);
    return decoded._tag === "Success" ? decoded.value : undefined;
  };
  const readRefusal = (text: string) => {
    const decoded = decode(text);
    if (decoded._tag !== "Failure") return undefined;
    return listDecodeIssues(Cause.squash(decoded.cause) as Schema.SchemaError)[0]?.message;
  };

  it("decodes a time with an offset or Z to the canonical UTC timestamp", () => {
    expect(decodeToUtc("2026-10-13T09:00+02:00")).toBe("2026-10-13T07:00:00.000Z");
    expect(decodeToUtc("2026-10-13T01:30:15-05:30")).toBe("2026-10-13T07:00:15.000Z");
    expect(decodeToUtc("2026-10-13T07:00:00.5Z")).toBe("2026-10-13T07:00:00.500Z");
    expect(decodeToUtc("2026-10-13T07:00:00.000Z")).toBe("2026-10-13T07:00:00.000Z");
    expect(decodeToUtc("2026-01-01T00:30+01:00")).toBe("2025-12-31T23:30:00.000Z");
  });

  it("refuses a time without an offset, and says to add one", () => {
    expect(readRefusal("2026-10-13T09:00")).toMatch(/has no offset/);
  });

  it("refuses a date, a time of day or an offset that does not exist", () => {
    expect(readRefusal("2026-02-30T09:00+02:00")).toMatch(/is not an exact time/);
    expect(readRefusal("2026-10-13T25:00Z")).toMatch(/is not an exact time/);
    expect(readRefusal("2026-10-13T09:00+24:00")).toMatch(/is not an exact time/);
    expect(readRefusal("tomorrow")).toMatch(/is not an exact time/);
  });

  it("is its own shorthand, so the command line converts the typed time the same way", () => {
    expect(readShorthandDecoder(SignalSnoozeInput.fields.until)?.("2026-10-13T09:00+02:00")).toBe(
      "2026-10-13T07:00:00.000Z",
    );
  });
});
