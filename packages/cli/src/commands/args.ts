/**
 * Parses a command line into one operation's request.
 *
 * - Positionals come first, in the order the command declares them.
 * - Every other field is a `--<flag>`, spelled as in the contract's CLI table.
 * - Paging uses `--limit`, `--cursor`, `--sort` and `--all`.
 *
 * Nothing here is specific to one operation: the rules are applied to the
 * `Command` the tree built.
 *
 * A field that holds content is read from stdin rather than from `argv`,
 * where a password would be visible in process lists and a document would
 * have to fit on one line. Such a field has no flag that takes a value. A
 * required one is always read; an optional one only when its `--<flag>-stdin`
 * marker is given, so an empty pipe never clears a field.
 *
 * `hercule user set-password` is the only command that reads two fields, one
 * line each, in the order its schema declares them. Never in the order the
 * markers were written, or the two passwords could silently swap.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { listDecodeIssues, type SortKey } from "@hercule/contract";
import { UsageError } from "../exit";
import type { Command, Field } from "./tree";

export interface Arguments {
  /** The positional arguments, in order, as written. */
  readonly positionals: ReadonlyArray<string>;
  readonly payload: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  readonly limit: number | undefined;
  readonly cursor: string | undefined;
  /** One key per `--sort`, in the order written; `undefined` when none was given. */
  readonly sort: ReadonlyArray<SortKey> | undefined;
  /** Whether to follow `nextCursor` to the last page. */
  readonly all: boolean;
  readonly json: boolean;
  /** The one-time setup token, for `setup complete`. */
  readonly setupToken: string | undefined;
}

/**
 * Returns a field's name for an error message, the way the caller had to write
 * it. A field read from stdin has no flag, and naming one would send the
 * reader looking for a flag that does not exist.
 */
export const formatFieldName = (field: Field): string =>
  field.stdin
    ? `${field.name} (on stdin)`
    : field.positional
      ? `<${field.spelling}>`
      : `--${field.spelling}`;

/**
 * Converts the text given for a field into the field's value. Throws a
 * `UsageError` when the text is not a valid value.
 *
 * A field whose schema has a shorthand is decoded by that schema, so the word
 * a person types becomes the value the API expects, and the typed shorthand is
 * never sent. On failure the user sees the schema's own error message: the
 * schema knows which forms the word may take, and this function does not.
 */
export const coerceFieldValue = (field: Field, text: string, help: string): unknown => {
  if (field.decodeShorthand !== undefined) {
    try {
      // For a query field, the derived client encodes the decoded value back
      // into the typed word. The round trip changes nothing, and the codec
      // stays the only place that defines what the word means.
      return field.decodeShorthand(text);
    } catch (failure) {
      // The codec's message lists the forms the word may take. Any wrapper
      // around it adds nothing the user can act on.
      const refusal = failure instanceof Error ? failure.message : String(failure);
      throw new UsageError(`${formatFieldName(field)}: ${refusal}`, help);
    }
  }
  if (field.choices !== undefined && !field.choices.includes(text)) {
    throw new UsageError(
      `${formatFieldName(field)}: ${text} is not one of ${field.choices.join(", ")}`,
      help,
    );
  }
  switch (field.kind) {
    case "string":
      return text;
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value))
        throw new UsageError(`${formatFieldName(field)}: ${text} is not a number`, help);
      return value;
    }
    case "boolean": {
      if (text === "true") return true;
      if (text === "false") return false;
      throw new UsageError(`${formatFieldName(field)}: ${text} is not true or false`, help);
    }
    case "json":
      try {
        return JSON.parse(text);
      } catch {
        throw new UsageError(`${formatFieldName(field)}: ${text} is not valid JSON`, help);
      }
  }
};

/**
 * Converts the text given for a field in `argv` into the field's value.
 *
 * The word `null` clears a nullable field, and it is checked first: a field
 * that accepts null accepts it whatever type its other values have, and
 * `null` is never one of a field's choices. The cost is that a nullable string
 * field cannot be set to the text "null", the usual trade-off for a command
 * line that spells null this way. Content read from stdin is a document, not
 * a shorthand, so it is not converted here.
 */
const parseWrittenValue = (field: Field, text: string, help: string): unknown =>
  field.nullable && text === "null" ? null : coerceFieldValue(field, text, help);

const assignFieldValue = (into: Record<string, unknown>, field: Field, value: unknown): void => {
  if (!field.repeated) {
    into[field.name] = value;
    return;
  }
  const existing = into[field.name];
  into[field.name] = Array.isArray(existing) ? [...(existing as Array<unknown>), value] : [value];
};

/**
 * Parses one `--sort <field>[:<asc|desc>]` into a sort key. Throws a
 * `UsageError` for a field the command cannot sort on, or an unknown
 * direction.
 *
 * A field with no direction leaves the direction unset, and the API reads a
 * key with no direction as `asc`. A field named twice is not refused here but
 * by `checkPaging`, with the contract's own message.
 */
const parseSort = (text: string, command: Command, help: string): SortKey => {
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
 * Checks the paging flags against the contract's schema for them. Throws a
 * `UsageError` naming each flag the schema refuses, such as a `--sort` that
 * names a field twice or a `--limit` out of range.
 *
 * The client would refuse the same values when it encodes the request, but
 * only after `execute` has looked up every id tail. A lookup is a call to the
 * API, and one that finds nothing fails first, with its own error and exit
 * code. Checking here means a wrong command line always exits 2 and sends
 * nothing.
 */
const checkPaging = (
  command: Command,
  paging: {
    readonly limit: number | undefined;
    readonly cursor: string | undefined;
    readonly sort: ReadonlyArray<SortKey> | undefined;
  },
  help: string,
): void => {
  if (command.pageQuery === undefined) return;
  const given = Object.fromEntries(
    Object.entries(paging).filter(([, value]) => value !== undefined),
  );
  const encoded = Schema.encodeUnknownResult(command.pageQuery)(given);
  if (Result.isFailure(encoded)) {
    const refused = listDecodeIssues(encoded.failure).map((issue) =>
      issue.path[0] === undefined ? issue.message : `--${String(issue.path[0])}: ${issue.message}`,
    );
    throw new UsageError(refused.join("; "), help);
  }
};

/**
 * One token of a command line: a positional argument, or a flag.
 *
 * `value()` reads a flag's value, from `--flag=value` or from the next token.
 * It throws a usage error when the flag has neither. A flag that takes no
 * value never calls it.
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
 * Splits a command line into tokens. Every command uses this one loop.
 *
 * It knows only what a token looks like, never what a flag means: the caller
 * decides that. `value()` moves the loop past the token it reads, so it must
 * be called before the next token is requested, which is what a `for...of`
 * body does naturally.
 */
export function* tokenize(tokens: ReadonlyArray<string>, help: string): Generator<Token> {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (!token.startsWith("--")) {
      // No flag of this CLI starts with a single dash, so `-x` is a mistake
      // rather than an argument. Treated as a positional, it would be taken
      // as an id and reported as one. A lone `-` is still a positional.
      if (token.startsWith("-") && token !== "-") {
        throw new UsageError(`unknown flag ${token}`, help);
      }
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
 * Parses the tokens after the command's words. Throws a `UsageError` for any
 * mistake in the command line.
 *
 * `readStdin` is called at most once, and only when the command has a field
 * to read from it, so a command that reads nothing from stdin never waits on
 * a pipe.
 *
 * A command given at least one `--image` may send empty text with its
 * images. So when `stdinIsTerminal` is true, it does not call `readStdin` at
 * all: each stdin field is sent empty, because a person at a terminal who
 * gave only images has no text to type. Piped stdin is read as usual, and an
 * empty pipe also sends empty text.
 */
export const parseArguments = async (
  command: Command,
  tokens: ReadonlyArray<string>,
  readStdin: () => Promise<string>,
  stdinIsTerminal = false,
): Promise<Arguments> => {
  const help = command.spelling;
  const payloadFields = new Map(command.payload.map((field) => [field.spelling, field]));
  const queryFields = new Map(command.query.map((field) => [field.spelling, field]));

  const positionals: Array<string> = [];
  const payload: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const marked = new Set<Field>();
  let limit: number | undefined;
  let cursor: string | undefined;
  let sort: Array<SortKey> | undefined;
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
      // Each `--sort` adds a key after the ones before it, so the first one
      // written orders the list and each later one breaks its ties.
      (sort ??= []).push(parseSort(value(), command, help));
      continue;
    }
    if (command.requires === "setup-token" && name === "setup-token") {
      setupToken = value();
      continue;
    }

    if (name.endsWith("-stdin")) {
      const field = payloadFields.get(name.slice(0, -"-stdin".length));
      if (field === undefined || !field.stdin) throw new UsageError(`unknown flag --${name}`, help);
      // The marker only asks for the read. It never takes the value, or the
      // value would be back in `argv`, which reading stdin exists to avoid.
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`, help);
      marked.add(field);
      continue;
    }

    const payloadField = payloadFields.get(name);
    const field = payloadField ?? queryFields.get(name);
    if (field === undefined) throw new UsageError(`unknown flag --${name}`, help);
    if (field.stdin) {
      throw new UsageError(
        `--${name} does not exist: ${command.id} reads ${field.name} from stdin, never from argv, where it would show in process lists and in shell history. Pipe it in; --${name}-stdin ${field.optional ? "tells the CLI to read it" : "is accepted but not needed"}.`,
        help,
      );
    }
    assignFieldValue(
      payloadField === undefined ? query : payload,
      field,
      parseWrittenValue(field, value(), help),
    );
  }

  // A required content field is always read; an optional one only when its
  // marker was given, so an empty pipe never clears a field nobody named.
  const reading = command.payload.filter(
    (field) => field.stdin && (!field.optional || marked.has(field)),
  );

  // Check everything that argv alone can decide before reading the pipe, so a
  // command line that cannot work does not consume stdin first.
  if (positionals.length !== command.positionals.length) {
    const expected = command.positionals.map((field) => `<${field.spelling}>`).join(" ");
    throw new UsageError(
      `${help} takes ${command.positionals.length} argument(s): ${expected || "none"}`,
      help,
    );
  }

  checkPaging(command, { limit, cursor, sort }, help);

  const missing = command.payload
    .filter((field) => !field.optional && !(field.name in payload) && !reading.includes(field))
    .map((field) => `--${field.spelling}${field.stdin ? "-stdin" : ""}`);
  if (missing.length > 0) {
    throw new UsageError(`missing required ${missing.join(", ")}`, help);
  }

  const sendsImages = command.payload.some((field) => field.uploads && field.name in payload);
  if (reading.length > 0 && sendsImages && stdinIsTerminal) {
    for (const field of reading) payload[field.name] = coerceFieldValue(field, "", help);
  } else if (reading.length > 0) {
    // Strip one trailing newline, because heredocs and editors add one. Files
    // saved on Windows end with `\r\n`, which counts as that newline.
    const text = (await readStdin()).replace(/\r?\n$/, "");
    if (reading.length === 1) {
      const field = reading[0]!;
      payload[field.name] = coerceFieldValue(field, text, help);
    } else {
      // Split at `\r\n` too, so no line of a Windows file keeps a trailing `\r`.
      const lines = text.split(/\r?\n/);
      if (lines.length !== reading.length) {
        throw new UsageError(
          `stdin has ${lines.length} line(s), but ${reading.length} fields are read from it, one per line: ${reading
            .map((field) => field.name)
            .join(", then ")}`,
          help,
        );
      }
      reading.forEach((field, index) => {
        payload[field.name] = coerceFieldValue(field, lines[index]!, help);
      });
    }
  }

  return { positionals, payload, query, limit, cursor, sort, all, json, setupToken };
};
