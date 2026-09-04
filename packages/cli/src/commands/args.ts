/**
 * Turning a command line into one operation's request.
 *
 * Path parameters are positional, in route order; payload and query fields are
 * `--<field>` flags; paging is `--limit`, `--cursor`, `--sort` and `--all`.
 * Nothing about a particular operation is written here:
 * the rules are applied to the `Command` the contract produced.
 *
 * Values that must not appear in `ps` or in shell history arrive on stdin
 * instead: every string field also has a `--<field>-stdin` form. Given once, it
 * takes all of stdin with one trailing newline removed, which is what a
 * heredoc produces; given more than once, stdin supplies one line per field, in
 * the order the operation's schema declares them - never in the order the flags
 * happened to be written, so `hydra user setPassword` always reads the current
 * password first.
 *
 * What arrives on stdin is read exactly as the flag's value is read, `coerce`
 * and all, so a field means the same thing however it was given: the bare word
 * `null` clears a nullable field from stdin as it does from `argv`.
 */
import { UsageError } from "../exit";
import type { Command, Field } from "./tree";

/**
 * Fields that may arrive **only** on stdin; the plain `--<field>` flag for one
 * of these does not exist.
 *
 * A bare `--password` flag does not exist, and the reason generalises:
 * anything in `argv` is visible in process lists and lands in shell history. So
 * every password the API takes, and a secret's value, is listed here.
 */
export const STDIN_ONLY = new Map<string, ReadonlyArray<string>>([
  ["setup.complete", ["password"]],
  ["auth.login", ["password"]],
  ["user.setPassword", ["current", "next"]],
  ["secret.set", ["value"]],
]);

/** True when this operation's field refuses a plain `--<field>` flag. */
export const isStdinOnly = (id: string, field: string): boolean =>
  STDIN_ONLY.get(id)?.includes(field) === true;

export interface SortArgument {
  readonly field: string;
  /** Absent when `--sort` named no direction: the operation's own default order stands. */
  readonly direction?: "asc" | "desc";
}

export interface Arguments {
  /** Path parameter values, in route order, as written. */
  readonly positionals: ReadonlyArray<string>;
  readonly payload: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  readonly limit: number | undefined;
  readonly cursor: string | undefined;
  readonly sort: SortArgument | undefined;
  /** Follow `nextCursor` to the end. */
  readonly all: boolean;
  readonly json: boolean;
  /** The one-time setup token, for `setup complete`. */
  readonly setupToken: string | undefined;
}

const coerce = (field: Field, text: string, help: string): unknown => {
  // The bare word `null` is how a nullable field is cleared, and it is checked
  // before anything else: a field that accepts null accepts it whatever shape
  // its other values have, and `null` is not one of a closed value set. The
  // cost is that a nullable string field cannot be given the four letters
  // themselves, which is the trade every command line that spells null makes.
  if (field.nullable && text === "null") return null;
  if (field.choices !== undefined && !field.choices.includes(text)) {
    throw new UsageError(
      `--${field.name}: ${text} is not one of ${field.choices.join(", ")}`,
      help,
    );
  }
  switch (field.kind) {
    case "string":
      return text;
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value))
        throw new UsageError(`--${field.name}: ${text} is not a number`, help);
      return value;
    }
    case "boolean": {
      if (text === "true") return true;
      if (text === "false") return false;
      throw new UsageError(`--${field.name}: ${text} is not true or false`, help);
    }
    case "json":
      try {
        return JSON.parse(text);
      } catch {
        throw new UsageError(`--${field.name}: ${text} is not valid JSON`, help);
      }
  }
};

const set = (into: Record<string, unknown>, field: Field, value: unknown): void => {
  if (!field.repeated) {
    into[field.name] = value;
    return;
  }
  const existing = into[field.name];
  into[field.name] = Array.isArray(existing) ? [...(existing as Array<unknown>), value] : [value];
};

/**
 * `--sort <field>[:<asc|desc>]`.
 *
 * A field with no direction leaves the direction unset rather than assuming
 * `asc`: the operation declares its own default order, and inventing one here
 * would silently override it.
 */
const parseSort = (text: string, command: Command, help: string): SortArgument => {
  const colon = text.indexOf(":");
  const field = colon === -1 ? text : text.slice(0, colon);
  if (!command.sortFields.includes(field)) {
    throw new UsageError(
      `--sort: ${field} is not sortable; ${command.id} sorts on ${command.sortFields.join(", ")}`,
      help,
    );
  }
  if (colon === -1) return { field };
  const direction = text.slice(colon + 1);
  if (direction !== "asc" && direction !== "desc") {
    throw new UsageError(`--sort: ${direction} is not asc or desc`, help);
  }
  return { field, direction };
};

/**
 * One token of a command line: a bare positional, or a flag.
 *
 * `value()` is what reads a flag's argument, from `--flag=value` or from the
 * next token; calling it on a flag that has neither is the usage error. A flag
 * that takes no value simply never calls it.
 */
export type Token =
  | { readonly kind: "positional"; readonly text: string }
  | {
      readonly kind: "flag";
      readonly name: string;
      /** The `value` of `--name=value`, or `undefined` when the token had no `=`. */
      readonly inline: string | undefined;
      readonly value: () => string;
    };

/**
 * The one command-line token loop, shared by every command.
 *
 * It knows only the shape of a token, never what any flag means: the caller
 * decides that. `value()` advances the loop past the token it consumed, so it
 * must be called before the generator is asked for the next token - which is
 * what a `for...of` body does naturally.
 */
export function* tokenize(tokens: ReadonlyArray<string>, help: string): Generator<Token> {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (!token.startsWith("--")) {
      yield { kind: "positional", text: token };
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    yield {
      kind: "flag",
      name,
      inline,
      value: () => {
        if (inline !== undefined) return inline;
        const next = tokens[++i];
        if (next === undefined) throw new UsageError(`--${name} needs a value`, help);
        return next;
      },
    };
  }
}

/**
 * Parse the tokens after `hydra <entity> <verb>`.
 *
 * `readStdin` is called at most once, and only when a `--<field>-stdin` flag
 * was given, so a command that takes nothing from stdin never blocks on a pipe.
 */
export const parseArguments = async (
  command: Command,
  tokens: ReadonlyArray<string>,
  readStdin: () => Promise<string>,
): Promise<Arguments> => {
  const help = `${command.entity} ${command.verb}`;
  const payloadFields = new Map(command.payload.map((field) => [field.name, field]));
  const queryFields = new Map(command.query.map((field) => [field.name, field]));

  const positionals: Array<string> = [];
  const payload: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const stdinFields: Array<Field> = [];
  let limit: number | undefined;
  let cursor: string | undefined;
  let sort: SortArgument | undefined;
  let all = false;
  let json = false;
  let setupToken: string | undefined;

  for (const token of tokenize(tokens, help)) {
    if (token.kind === "positional") {
      positionals.push(token.text);
      continue;
    }
    const { name, inline, value } = token;

    if (name === "json") {
      json = true;
      continue;
    }
    if (command.paged && name === "all") {
      all = true;
      continue;
    }
    if (command.paged && name === "limit") {
      const text = value();
      const parsed = Number(text);
      if (!Number.isInteger(parsed))
        throw new UsageError(`--limit: ${text} is not a whole number`, help);
      limit = parsed;
      continue;
    }
    if (command.paged && name === "cursor") {
      cursor = value();
      continue;
    }
    if (command.paged && name === "sort") {
      sort = parseSort(value(), command, help);
      continue;
    }
    if (command.requires === "setup-token" && name === "setup-token") {
      setupToken = value();
      continue;
    }

    if (name.endsWith("-stdin")) {
      const field = payloadFields.get(name.slice(0, -"-stdin".length));
      if (field === undefined || field.kind !== "string" || field.repeated) {
        throw new UsageError(`unknown flag --${name}`, help);
      }
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`, help);
      stdinFields.push(field);
      continue;
    }

    const payloadField = payloadFields.get(name);
    if (payloadField !== undefined) {
      if (isStdinOnly(command.id, name)) {
        throw new UsageError(
          `--${name} does not exist: it would be visible in process lists and in shell history. ${command.id} reads it from stdin, as --${name}-stdin.`,
          help,
        );
      }
      set(payload, payloadField, coerce(payloadField, value(), help));
      continue;
    }

    const queryField = queryFields.get(name);
    if (queryField !== undefined) {
      set(query, queryField, coerce(queryField, value(), help));
      continue;
    }

    throw new UsageError(`unknown flag --${name}`, help);
  }

  if (stdinFields.length > 0) {
    // Declaration order, not flag order: `--next-stdin --current-stdin` must
    // read the same two lines as `--current-stdin --next-stdin`, or the flags
    // would silently swap two passwords.
    const ordered = command.payload.filter((field) => stdinFields.includes(field));
    const text = await readStdin();
    if (ordered.length === 1) {
      const field = ordered[0]!;
      payload[field.name] = coerce(field, text.replace(/\n$/, ""), help);
    } else {
      const lines = text.replace(/\n$/, "").split("\n");
      if (lines.length !== ordered.length) {
        throw new UsageError(
          `stdin has ${lines.length} line(s) but ${ordered.length} fields read from it: ${ordered
            .map((field) => field.name)
            .join(", then ")}`,
          help,
        );
      }
      ordered.forEach((field, index) => {
        payload[field.name] = coerce(field, lines[index]!, help);
      });
    }
  }

  if (positionals.length !== command.positionals.length) {
    const expected = command.positionals.map((field) => `<${field.name}>`).join(" ");
    throw new UsageError(
      `${command.entity} ${command.verb} takes ${command.positionals.length} argument(s): ${expected || "none"}`,
      help,
    );
  }

  const missing = command.payload
    .filter((field) => !field.optional && !(field.name in payload))
    .map((field) =>
      isStdinOnly(command.id, field.name) ? `--${field.name}-stdin` : `--${field.name}`,
    );
  if (missing.length > 0) {
    throw new UsageError(`missing required ${missing.join(", ")}`, help);
  }

  return { positionals, payload, query, limit, cursor, sort, all, json, setupToken };
};
