import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { parseGlobalOptions } from "./args";

const parseOrFail = (argv: ReadonlyArray<string>) => {
  const result = parseGlobalOptions(argv);
  if (Result.isFailure(result)) throw new Error(`unexpected failure: ${result.failure.message}`);
  return result.success;
};

const readParseFailure = (argv: ReadonlyArray<string>) => {
  const result = parseGlobalOptions(argv);
  if (Result.isSuccess(result)) throw new Error("expected a failure");
  return result.failure;
};

describe("parseGlobalOptions", () => {
  it("reads both forms of --home", () => {
    expect(parseOrFail(["--home", "/tmp/h"]).home).toBe("/tmp/h");
    expect(parseOrFail(["--home=/tmp/h"]).home).toBe("/tmp/h");
  });

  it("keeps every override in order", () => {
    expect(parseOrFail(["-c", "bind.port=1", "-c", "bind.host=0.0.0.0"]).overrides).toEqual([
      ["bind.port", "1"],
      ["bind.host", "0.0.0.0"],
    ]);
  });

  it("leaves a glued -c form to the role, rather than claiming every -c* flag", () => {
    expect(parseOrFail(["-cbind.port=1", "serve"]).rest).toEqual(["-cbind.port=1", "serve"]);
  });

  it("keeps a value containing an equals sign whole", () => {
    expect(parseOrFail(["-c", "data.dir=/tmp/a=b"]).overrides).toEqual([["data.dir", "/tmp/a=b"]]);
  });

  it("takes the last --home on the line", () => {
    expect(parseOrFail(["--home", "/tmp/a", "--home=/tmp/b"]).home).toBe("/tmp/b");
  });

  it("strips the options and leaves everything else in order", () => {
    const options = parseOrFail(["serve", "--home", "/tmp/h", "-c", "bind.port=1", "--verbose"]);
    expect(options.rest).toEqual(["serve", "--verbose"]);
  });

  it("reports where the verb sat, so the dispatcher can hand the rest on untouched", () => {
    expect(parseOrFail(["--home", "/tmp/h", "serve"]).verbIndex).toBe(2);
    expect(parseOrFail(["-c", "bind.port=1", "serve", "extra"]).verbIndex).toBe(2);
    // A verb that repeats an option value is still found by position.
    expect(parseOrFail(["--home", "serve", "serve"]).verbIndex).toBe(2);
    expect(parseOrFail(["--home", "/tmp/h"]).verbIndex).toBe(2);
  });

  it("has no home when none is given", () => {
    expect(parseOrFail(["serve"]).home).toBeUndefined();
  });

  it("rejects a --home without a directory", () => {
    expect(readParseFailure(["--home"]).message).toContain("directory");
    expect(readParseFailure(["--home="]).message).toContain("directory");
  });

  it("rejects an override that is not key=value", () => {
    expect(readParseFailure(["-c"]).message).toContain("key=value");
    expect(readParseFailure(["-c", "bind.port"]).message).toContain("key=value");
    expect(readParseFailure(["-c", "=4937"]).message).toContain("key=value");
  });
});
