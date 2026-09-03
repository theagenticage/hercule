import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { formatToml, parseToml } from "./toml";

const parsed = (text: string) => {
  const result = parseToml(text);
  if (Result.isFailure(result)) throw new Error(`unexpected failure: ${result.failure}`);
  return result.success;
};

const failure = (text: string) => {
  const result = parseToml(text);
  if (Result.isSuccess(result)) throw new Error("expected a failure");
  return result.failure;
};

describe("parseToml", () => {
  it("flattens table headers and dotted keys to the same dotted form", () => {
    expect(parsed('[bind]\nhost = "0.0.0.0"\nport = 4937\n')).toEqual({
      "bind.host": "0.0.0.0",
      "bind.port": 4937,
    });
    expect(parsed('bind.host = "0.0.0.0"\n')).toEqual({ "bind.host": "0.0.0.0" });
  });

  it("reads strings, numbers and booleans", () => {
    expect(parsed('a = "text" # trailing\nb = -12_000\nc = 1.5\nd = true\n')).toEqual({
      a: "text",
      b: -12000,
      c: 1.5,
      d: true,
    });
  });

  it("reports what it could not read", () => {
    expect(failure('bind.host = "0.0.0.0"\nbind.port = ?\n')).toContain("Expected a value");
    expect(failure("[bind\n")).toContain("table header");
    expect(failure("bind.hosts = [1, 2]\n")).toContain("bind.hosts");
  });
});

describe("formatToml", () => {
  it("writes dotted keys that read back unchanged", () => {
    const values = { "data.dir": "data", "bind.port": 4937, "log.level": "info" };
    expect(formatToml(values)).toBe(
      ['data.dir = "data"', "bind.port = 4937", 'log.level = "info"', ""].join("\n"),
    );
    expect(parsed(formatToml(values))).toEqual(values);
  });
});
