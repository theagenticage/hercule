import { Result } from "effect";

/** The scalar TOML values a bootstrap key may hold. */
export type TomlScalar = string | number | boolean;

/**
 * Read `config.toml` and flatten it to dotted keys: `[bind]` + `port = 4937`
 * and `bind.port = 4937` both read as `bind.port`.
 *
 * The parser is Bun's, which the binary and the tests both run on, so this is
 * only the flattening. Bootstrap config is four scalar keys Hydra authors
 * itself (spec 15 section 6), so anything that is not a scalar or a table is
 * rejected by the key it sits under; the caller rejects the keys it does not
 * know.
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

/** Render the bootstrap keys as dotted-key TOML, one key per line. */
export function formatToml(values: Record<string, TomlScalar>): string {
  const line = (key: string, value: TomlScalar) =>
    `${key} = ${typeof value === "string" ? JSON.stringify(value) : String(value)}`;
  return `${Object.entries(values)
    .map(([key, value]) => line(key, value))
    .join("\n")}\n`;
}

/** Walks the parsed tables into dotted keys, or names the first key it cannot flatten. */
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
      return `${path} holds a value Hydra cannot read; every bootstrap key is a string, a number or a boolean`;
    }
  }
  return undefined;
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
