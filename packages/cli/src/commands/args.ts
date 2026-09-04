/**
 * Turning a command line into one operation's request.
 *
 * Path parameters are positional, in route order; payload and query fields are
 * `--<field>` flags; paging is `--limit`, `--cursor`, `--sort` and `--all`
 * (spec 11 section 6.3). Nothing about a particular operation is written here:
 * the rules are applied to the `Command` the contract produced.
 *
 * Values that must not appear in `ps` or in shell history arrive on stdin
 * instead: every string field also has a `--<field>-stdin` form. Given once, it
 * takes all of stdin with one trailing newline removed, which is what a
 * heredoc produces; given more than once, stdin supplies one line per flag, in
 * the order the flags were written.
 */
import { UsageError } from "../exit";
import type { Command, Field } from "./tree";

/**
 * Fields that may only arrive on stdin.
 *
 * The one content channel rule (spec 11 section 6.3): a secret's value must
 * never sit in `argv`, where `ps` and shell history can see it. Passwords on
 * `auth login` and `user setPassword` are deliberately *not* here - they have
 * a `--<field>-stdin` form and the flag stays available for a caller who has
 * already decided the exposure is acceptable, which is what `hydra login`
 * exists to avoid.
 */
export const STDIN_ONLY = new Map<string, string>([["secret.set", "value"]]);

export interface SortArgument {
  readonly field: string;
  readonly direction: "asc" | "desc";
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

const parseSort = (text: string, command: Command, help: string): SortArgument => {
  const [field = "", direction = "asc"] = text.split(":");
  if (!command.sortFields.includes(field)) {
    throw new UsageError(
      `--sort: ${field} is not sortable; ${command.id} sorts on ${command.sortFields.join(", ")}`,
      help,
    );
  }
  if (direction !== "asc" && direction !== "desc") {
    throw new UsageError(`--sort: ${direction} is not asc or desc`, help);
  }
  return { field, direction };
};

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

  const take = (index: number, flag: string): [string, number] => {
    const value = tokens[index + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`, help);
    return [value, index + 1];
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const [taken, next] = take(i, `--${name}`);
      i = next;
      return taken;
    };

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
      if (STDIN_ONLY.get(command.id) === name) {
        throw new UsageError(
          `--${name} is not accepted; ${command.id} reads it from stdin, as --${name}-stdin`,
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
    const text = await readStdin();
    if (stdinFields.length === 1) {
      payload[stdinFields[0]!.name] = text.replace(/\n$/, "");
    } else {
      const lines = text.split("\n");
      stdinFields.forEach((field, index) => {
        const line = lines[index];
        if (line === undefined) {
          throw new UsageError(
            `stdin has ${lines.length} lines but ${stdinFields.length} --*-stdin flags were given`,
            help,
          );
        }
        payload[field.name] = line;
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
      STDIN_ONLY.get(command.id) === field.name ? `--${field.name}-stdin` : `--${field.name}`,
    );
  if (missing.length > 0) {
    throw new UsageError(`missing required ${missing.join(", ")}`, help);
  }

  return { positionals, payload, query, limit, cursor, sort, all, json, setupToken };
};
