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

  it("ignores comments and blank lines, and keeps a # inside a string", () => {
    expect(parsed('# a comment\n\nlog.level = "info" # trailing\ntag = "a#b"\n')).toEqual({
      "log.level": "info",
      tag: "a#b",
    });
  });

  it("reads literal strings, escapes, integers, floats and booleans", () => {
    expect(parsed(`a = 'C:\\raw'\nb = "line\\nbreak"\nc = -12_000\nd = 1.5\ne = true\n`)).toEqual({
      a: "C:\\raw",
      b: "line\nbreak",
      c: -12000,
      d: 1.5,
      e: true,
    });
  });

  it("names the line it could not read", () => {
    expect(failure('bind.host = "0.0.0.0"\nbind.port = ?\n')).toContain("line 2");
    expect(failure("[bind\n")).toContain("line 1");
    expect(failure("bind.port\n")).toContain("line 1");
    expect(failure('bind.host = "unterminated\n')).toContain("line 1");
  });
});

describe("formatToml", () => {
  it("writes dotted keys that read back unchanged", () => {
    const values = { "data.dir": "/home/u/.hydra/data", "bind.port": 4937, "log.level": "info" };
    expect(formatToml(values)).toBe(
      ['data.dir = "/home/u/.hydra/data"', "bind.port = 4937", 'log.level = "info"', ""].join("\n"),
    );
    expect(parsed(formatToml(values))).toEqual(values);
  });
});
