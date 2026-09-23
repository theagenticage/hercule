import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { formatToml, parseToml } from "./toml";

const parseOrFail = (text: string) => {
  const result = parseToml(text);
  if (Result.isFailure(result)) throw new Error(`unexpected failure: ${result.failure}`);
  return result.success;
};

const parseAndReadFailure = (text: string) => {
  const result = parseToml(text);
  if (Result.isSuccess(result)) throw new Error("expected a failure");
  return result.failure;
};

describe("parseToml", () => {
  it("flattens table headers and dotted keys to the same dotted form", () => {
    expect(parseOrFail('[bind]\nhost = "0.0.0.0"\nport = 4937\n')).toEqual({
      "bind.host": "0.0.0.0",
      "bind.port": 4937,
    });
    expect(parseOrFail('bind.host = "0.0.0.0"\n')).toEqual({ "bind.host": "0.0.0.0" });
  });

  it("reads strings, numbers and booleans", () => {
    expect(parseOrFail('a = "text" # trailing\nb = -12_000\nc = 1.5\nd = true\n')).toEqual({
      a: "text",
      b: -12000,
      c: 1.5,
      d: true,
    });
  });

  it("returns an error message for text it cannot read", () => {
    expect(parseAndReadFailure('bind.host = "0.0.0.0"\nbind.port = ?\n')).toContain(
      "Expected a value",
    );
    expect(parseAndReadFailure("[bind\n")).toContain("table header");
    expect(parseAndReadFailure("bind.hosts = [1, 2]\n")).toContain("bind.hosts");
  });

  it("rejects a datetime rather than dropping the key", () => {
    // Bun parses a TOML datetime into a Temporal value, which has no entries to
    // flatten. Any value that is not a scalar or a plain object is invalid.
    expect(parseAndReadFailure("backup.time = 1979-05-27T07:32:00Z\n")).toContain("backup.time");
    expect(parseAndReadFailure("backup.day = 1979-05-27\n")).toContain("backup.day");
    expect(parseAndReadFailure("backup.at = 07:32:00\n")).toContain("backup.at");
  });
});

describe("formatToml", () => {
  it("writes dotted keys that read back unchanged", () => {
    const values = { "data.dir": "data", "bind.port": 4937, "log.level": "info" };
    expect(formatToml(values)).toBe(
      ['data.dir = "data"', "bind.port = 4937", 'log.level = "info"', ""].join("\n"),
    );
    expect(parseOrFail(formatToml(values))).toEqual(values);
  });
});
