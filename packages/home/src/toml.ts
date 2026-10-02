import { Result } from "effect";

/** The scalar TOML values a bootstrap key may hold. */
export type TomlScalar = string | number | boolean;

/**
 * Parses `config.toml` and flattens it to dotted keys: `[bind]` + `port = 4937`
 * and `bind.port = 4937` both become `bind.port`. Returns a failure with the
 * error message when the text is not TOML or holds a value that is not a
 * scalar.
 *
 * The parser is Bun's, which both the binary and the tests run on, so this
 * function only flattens. Bootstrap config is four scalar keys Hercule writes
 * itself (spec 15 section 6), so any value that is not a scalar or a table is
 * rejected, and the error names its key. The caller rejects the keys it does
 * not know.
 */
export function parseToml(text: string): Result.Result<Record<string, TomlScalar>, string> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (cause) {
    return Result.fail(cause instanceof Error ? cause.message : String(cause));
  }
  const values: Record<string, TomlScalar> = {};
  const failure = flatten(parsed as Record<string, unknown>, "", values);
  return failure === undefined ? Result.succeed(values) : Result.fail(failure);
}

/** Formats the bootstrap keys as dotted-key TOML, one key per line. */
export function formatToml(values: Record<string, TomlScalar>): string {
  const formatLine = (key: string, value: TomlScalar) =>
    `${key} = ${typeof value === "string" ? JSON.stringify(value) : String(value)}`;
  return `${Object.entries(values)
    .map(([key, value]) => formatLine(key, value))
    .join("\n")}\n`;
}

/**
 * Flattens the parsed tables into dotted keys in `into`. Returns an error
 * message for the first key it cannot flatten, or `undefined`.
 */
function flatten(
  table: Record<string, unknown>,
  prefix: string,
  into: Record<string, TomlScalar>,
): string | undefined {
  for (const [key, value] of Object.entries(table)) {
    const path = `${prefix}${key}`;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      into[path] = value;
    } else if (isTable(value)) {
      const failure = flatten(value, `${path}.`, into);
      if (failure !== undefined) return failure;
    } else {
      return `${path} holds a value Hercule cannot read; every bootstrap key is a string, a number or a boolean`;
    }
  }
  return undefined;
}

/**
 * Checks that a value is a table, which means a plain object. Bun returns a
 * `Temporal` value for a TOML datetime. A looser check would accept that value,
 * find no entries in it, and silently drop the key.
 */
const isTable = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};
