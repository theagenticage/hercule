import { Result } from "effect";

/** The scalar TOML values a bootstrap key may hold. */
export type TomlScalar = string | number | boolean;

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const INTEGER = /^[+-]?(0|[1-9][0-9]*)$/;
const FLOAT = /^[+-]?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/**
 * Read the TOML subset `config.toml` is written in, flattened to dotted keys:
 * `[bind]` + `port = 4937` and `bind.port = 4937` both read as `bind.port`.
 *
 * Bootstrap config is four scalar keys Hydra authors itself (spec 15 section
 * 6), so this covers comments, table headers, dotted keys, quoted and literal
 * strings, integers, floats and booleans, and rejects everything else by line.
 * A hand-written reader rather than a runtime builtin because the tests and the
 * binary run on different runtimes; the file it accepts is ordinary TOML.
 */
export function parseToml(text: string): Result.Result<Record<string, TomlScalar>, string> {
  const values: Record<string, TomlScalar> = {};
  let prefix = "";

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]!).trim();
    const at = (message: string) => Result.fail(`line ${i + 1}: ${message}`);
    if (line === "") continue;

    if (line.startsWith("[")) {
      if (!line.endsWith("]")) return at("unterminated table header");
      const header = line.slice(1, -1).trim();
      const path = readKey(header);
      if (path === undefined) return at(`unsupported table header [${header}]`);
      prefix = `${path}.`;
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) return at("expected key = value");
    const key = readKey(line.slice(0, separator).trim());
    if (key === undefined) return at("unsupported key");
    const value = readValue(line.slice(separator + 1).trim());
    if (value === undefined) return at(`unsupported value for ${prefix}${key}`);
    values[`${prefix}${key}`] = value;
  }

  return Result.succeed(values);
}

/** Render the bootstrap keys as dotted-key TOML, one key per line. */
export function formatToml(values: Record<string, TomlScalar>): string {
  const line = (key: string, value: TomlScalar) =>
    `${key} = ${typeof value === "string" ? JSON.stringify(value) : String(value)}`;
  return `${Object.entries(values)
    .map(([key, value]) => line(key, value))
    .join("\n")}\n`;
}

/** Everything after an unquoted `#`. Quotes are respected, escapes are not keys. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const character = line[i]!;
    if (quote !== undefined) {
      if (character === "\\" && quote === '"') i++;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** A bare key or dotted path of bare keys, normalized to dotted form. */
function readKey(input: string): string | undefined {
  if (input === "") return undefined;
  const parts = input.split(".").map((part) => part.trim());
  return parts.every((part) => BARE_KEY.test(part)) ? parts.join(".") : undefined;
}

function readValue(input: string): TomlScalar | undefined {
  if (input === "") return undefined;
  if (input.startsWith('"')) return readBasicString(input);
  if (input.startsWith("'")) {
    return input.length >= 2 && input.endsWith("'") && !input.slice(1, -1).includes("'")
      ? input.slice(1, -1)
      : undefined;
  }
  if (input === "true") return true;
  if (input === "false") return false;
  const number = input.replaceAll("_", "");
  if (INTEGER.test(number)) return Number.parseInt(number, 10);
  if (FLOAT.test(number)) return Number.parseFloat(number);
  return undefined;
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  n: "\n",
  t: "\t",
  r: "\r",
};

function readBasicString(input: string): string | undefined {
  let out = "";
  for (let i = 1; i < input.length; i++) {
    const character = input[i]!;
    if (character === '"') return i === input.length - 1 ? out : undefined;
    if (character !== "\\") {
      out += character;
      continue;
    }
    const escape = ESCAPES[input[++i] ?? ""];
    if (escape === undefined) return undefined;
    out += escape;
  }
  return undefined;
}
