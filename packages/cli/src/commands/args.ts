/**
 * Turning a command line into one operation's request.
 *
 * Positionals come first, in the order the command writes them; every other
 * field is `--<flag>`, spelled as the contract's CLI table spells it; paging is
 * `--limit`, `--cursor`, `--sort` and `--all`. Nothing about a particular
 * operation is written here: the rules are applied to the `Command` the tree
 * produced.
 *
 * One field per command carries content, and it arrives on stdin rather than in
 * `argv`, where a password would be visible in process lists and a document
 * would have to be folded onto one line. Such a field has no inline flag at
 * all. Required, it is read unasked; optional, only when its
 * `--<flag>-stdin` marker says so, so an empty pipe never blanks a field.
 *
 * `hercule user set-password` is the one command that reads two fields, one line
 * each, in the order its schema declares them - never in the order the markers
 * were written, or two passwords would silently swap.
 */
import { UsageError } from "../exit";
import type { Command, Field } from "./tree";

export interface SortArgument {
  readonly field: string;
  /** Absent when `--sort` named no direction: the operation's own default order stands. */
  readonly direction?: "asc" | "desc";
}

export interface Arguments {
  /** The bare words, in the order the command takes them, as written. */
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

/**
 * How a message names a field: the way the caller had to write it. A field read
 * from stdin has no flag to name, and naming one would send the reader looking
 * for a flag that does not exist.
 */
export const said = (field: Field): string =>
  field.stdin
    ? `${field.name} (on stdin)`
    : field.positional
      ? `<${field.spelling}>`
      : `--${field.spelling}`;

/**
 * The value a field holds, from the text that was written for it.
 *
 * A field whose schema carries a shorthand is decoded by that schema, so the
 * one word a person types becomes the value the wire carries and the terminal's
 * spelling is never sent. The schema's own refusal is what the writer reads:
 * it knows the forms the word may take, and this loop does not.
 */
export const coerce = (field: Field, text: string, help: string): unknown => {
  if (field.decodeShorthand !== undefined) {
    try {
      // For a query field the derived client encodes the decoded value back to
      // the written word, so the round trip costs nothing and the one codec
      // still owns what the word means.
      return field.decodeShorthand(text);
    } catch (failure) {
      // The codec's own message says which forms the word may take. The error
      // around it is the decoder's wrapper and says nothing a writer can act
      // on.
      const refusal = failure instanceof Error ? failure.message : String(failure);
      throw new UsageError(`${said(field)}: ${refusal}`, help);
    }
  }
  if (field.choices !== undefined && !field.choices.includes(text)) {
    throw new UsageError(`${said(field)}: ${text} is not one of ${field.choices.join(", ")}`, help);
  }
  switch (field.kind) {
    case "string":
      return text;
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value))
        throw new UsageError(`${said(field)}: ${text} is not a number`, help);
      return value;
    }
    case "boolean": {
      if (text === "true") return true;
      if (text === "false") return false;
      throw new UsageError(`${said(field)}: ${text} is not true or false`, help);
    }
    case "json":
      try {
        return JSON.parse(text);
      } catch {
        throw new UsageError(`${said(field)}: ${text} is not valid JSON`, help);
      }
  }
};

/**
 * The value a field holds, from the text written for it in `argv`.
 *
 * The bare word `null` is how a nullable field is cleared, and it is checked
 * before anything else: a field that accepts null accepts it whatever shape its
 * other values have, and `null` is not one of a closed value set. The cost is
 * that a nullable string field cannot be given the four letters themselves,
 * which is the trade every command line that spells null makes. Content read
 * from stdin is a document and never a shortcut, so it does not pass here.
 */
const written = (field: Field, text: string, help: string): unknown =>
  field.nullable && text === "null" ? null : coerce(field, text, help);

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
      // A single dash is a word every shell knows and no flag of this CLI is
      // spelled with one, so `-x` is a mistake rather than an argument: taken
      // as a positional it would be counted as an id and reported as one.
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
 * Parse the tokens after the command's own words.
 *
 * `readStdin` is called at most once, and only when the command has a field to
 * read from it, so a command that takes nothing from stdin never blocks on a
 * pipe.
 */
export const parseArguments = async (
  command: Command,
  tokens: ReadonlyArray<string>,
  readStdin: () => Promise<string>,
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
      if (field === undefined || !field.stdin) throw new UsageError(`unknown flag --${name}`, help);
      // The marker asks for the read; it never carries the value, or the value
      // would be back in `argv`, which is the whole point of reading stdin.
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`, help);
      marked.add(field);
      continue;
    }

    const payloadField = payloadFields.get(name);
    const field = payloadField ?? queryFields.get(name);
    if (field === undefined) throw new UsageError(`unknown flag --${name}`, help);
    if (field.stdin) {
      throw new UsageError(
        `--${name} does not exist: ${command.id} reads ${field.name} from stdin, never from argv, where it would show in process lists and in shell history. Pipe it in; --${name}-stdin ${field.optional ? "asks for the read" : "is accepted and not needed"}.`,
        help,
      );
    }
    set(payloadField === undefined ? query : payload, field, written(field, value(), help));
  }

  // A required content field is read unasked; an optional one only where its
  // marker said so, so an empty pipe never blanks a field that was not named.
  const reading = command.payload.filter(
    (field) => field.stdin && (!field.optional || marked.has(field)),
  );

  // Everything argv alone can settle is settled before the pipe is touched, so
  // a command line that was never going to work does not first consume stdin.
  if (positionals.length !== command.positionals.length) {
    const expected = command.positionals.map((field) => `<${field.spelling}>`).join(" ");
    throw new UsageError(
      `${help} takes ${command.positionals.length} argument(s): ${expected || "none"}`,
      help,
    );
  }

  const missing = command.payload
    .filter((field) => !field.optional && !(field.name in payload) && !reading.includes(field))
    .map((field) => `--${field.spelling}${field.stdin ? "-stdin" : ""}`);
  if (missing.length > 0) {
    throw new UsageError(`missing required ${missing.join(", ")}`, help);
  }

  if (reading.length > 0) {
    // Strip one trailing newline, because heredocs and editors add one. Files
    // saved on Windows end with `\r\n`, which counts as that newline.
    const text = (await readStdin()).replace(/\r?\n$/, "");
    if (reading.length === 1) {
      const field = reading[0]!;
      payload[field.name] = coerce(field, text, help);
    } else {
      // Split at `\r\n` too, so no line of a Windows file keeps a trailing `\r`.
      const lines = text.split(/\r?\n/);
      if (lines.length !== reading.length) {
        throw new UsageError(
          `stdin has ${lines.length} line(s) but ${reading.length} fields read from it: ${reading
            .map((field) => field.name)
            .join(", then ")}`,
          help,
        );
      }
      reading.forEach((field, index) => {
        payload[field.name] = coerce(field, lines[index]!, help);
      });
    }
  }

  return { positionals, payload, query, limit, cursor, sort, all, json, setupToken };
};
