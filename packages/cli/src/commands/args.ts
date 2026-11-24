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
 * `hercule user set-password` and `hercule model-profile update` read two
 * fields, one line each, in the order their schema declares them. Never in the
 * order the markers were written, or the two values could silently swap.
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
 * Returns a flag as the caller writes it to give the field. A field read from
 * stdin is given by its marker, `--<flag>-stdin`.
 */
const formatFlagToGive = (field: Field): string =>
  `--${field.spelling}${field.stdin ? "-stdin" : ""}`;

/**
 * Returns how a positional is shown in usage lines: `<signal-id>`,
 * `<signal-id>...` for a list positional, which takes one or more words, or
 * `[<runner-id>]` for one that may be left out.
 */
export const formatPositionalShape = (field: Field): string =>
  field.optional
    ? `[<${field.spelling}>]`
    : field.repeated
      ? `<${field.spelling}>...`
      : `<${field.spelling}>`;

/**
 * Converts the text given for a field into the field's value. Throws a
 * `UsageError` when the text is not a valid value.
 *
 * For a field that takes named values, the text is one `<field>=<value>` and
 * the result is an object with that one entry. The text is split at the first
 * `=`, so a value may hold `=` itself.
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
  if (field.choices !== undefined && !field.choices.has(text)) {
    throw new UsageError(
      `${formatFieldName(field)}: ${text} is not one of ${[...field.choices.keys()].join(", ")}`,
      help,
    );
  }
  // The schema's own value for a choice, which differs from the typed one
  // when a camelCase value is typed in kebab case.
  const choice = field.choices?.get(text);
  switch (field.kind) {
    case "string":
      return choice ?? text;
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
        // A secret field holds a token or a code, and a message that quotes it
        // lands in the terminal and the shell's scrollback.
        throw new UsageError(
          field.secret
            ? `${formatFieldName(field)}: expected a JSON object on stdin`
            : `${formatFieldName(field)}: ${text} is not valid JSON`,
          help,
        );
      }
    case "namedValues": {
      const equals = text.indexOf("=");
      if (equals < 1) {
        throw new UsageError(
          `${formatFieldName(field)}: ${JSON.stringify(text)} is not written <field>=<value>`,
          help,
        );
      }
      return { [text.slice(0, equals)]: text.slice(equals + 1) };
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

/**
 * Returns the value given for a field in a request part, or `undefined` when
 * none was. A flag that fills one key of an object field is read from inside
 * that object.
 */
export const readGivenValue = (given: Record<string, unknown>, field: Field): unknown =>
  field.within === undefined
    ? given[field.name]
    : (given[field.within] as Record<string, unknown> | undefined)?.[field.name];

/**
 * Sets the value of a field in the request part `into`. A flag that fills one
 * key of an object field sets that key in a copy of the object.
 */
export const setGivenValue = (
  into: Record<string, unknown>,
  field: Field,
  value: unknown,
): void => {
  if (field.within === undefined) {
    into[field.name] = value;
    return;
  }
  const object = (into[field.within] ?? {}) as Record<string, unknown>;
  into[field.within] = { ...object, [field.name]: value };
};

/**
 * Adds one value given for a field to the request part `into`. A list field
 * collects its values in order, and a field that takes named values collects
 * them into one object. Throws a `UsageError` when a name is given twice,
 * because keeping either value would silently drop the other.
 */
const assignFieldValue = (
  into: Record<string, unknown>,
  field: Field,
  value: unknown,
  help: string,
): void => {
  if (field.kind === "namedValues") {
    const collected = (into[field.name] ?? {}) as Record<string, string>;
    const entry = value as Record<string, string>;
    const name = Object.keys(entry)[0]!;
    if (Object.hasOwn(collected, name)) {
      throw new UsageError(`${formatFieldName(field)}: ${name} is given twice`, help);
    }
    into[field.name] = { ...collected, ...entry };
    return;
  }
  if (!field.repeated) {
    setGivenValue(into, field, value);
    return;
  }
  const existing = into[field.name];
  into[field.name] = Array.isArray(existing) ? [...(existing as Array<unknown>), value] : [value];
};

/**
 * Picks the entry of each `oneOf` field by the selector flag the command line
 * gave, adds the entry's fixed values to the field in `payload`, and returns
 * the fields of the entries not picked. Throws a `UsageError` when two
 * selectors are given, when no selector is given for a field the request
 * needs, or when a flag is given that the picked entry has no key for.
 *
 * A field the request may leave out (`optional`) picks no entry when none of
 * its flags is given, and all its flags count as not picked.
 */
const pickEntries = (
  command: Command,
  payload: Record<string, unknown>,
  marked: ReadonlySet<Field>,
  help: string,
): ReadonlySet<Field> => {
  const unpicked = new Set<Field>();
  const wasGiven = (field: Field): boolean =>
    readGivenValue(payload, field) !== undefined || marked.has(field);
  for (const choice of command.choices) {
    const toGive = choice.entries
      .map((entry) =>
        [
          ...new Set([
            entry.selector,
            ...entry.flags.map((flag) => flag.field).filter((field) => !field.optional),
          ]),
        ]
          .map(formatFlagToGive)
          .join(" and "),
      )
      .join(", or ");
    const picked = choice.entries.filter((entry) => wasGiven(entry.selector));
    if (picked.length === 0) {
      const flagGiven = choice.entries.some((entry) =>
        entry.flags.some((flag) => wasGiven(flag.field)),
      );
      if (choice.optional && !flagGiven) {
        for (const entry of choice.entries)
          for (const flag of entry.flags) unpicked.add(flag.field);
        continue;
      }
      throw new UsageError(`no flag says which form to use: give ${toGive}`, help);
    }
    if (picked.length > 1) {
      throw new UsageError(
        `${formatFlagToGive(picked[1]!.selector)} cannot be given with ${formatFlagToGive(picked[0]!.selector)}: give ${toGive}`,
        help,
      );
    }
    const entry = picked[0]!;
    const keys = entry.flags.map((flag) => flag.field);
    const others = choice.entries
      .flatMap((one) => one.flags.map((flag) => flag.field))
      .filter((field) => !keys.includes(field));
    const stray = others.find(wasGiven);
    if (stray !== undefined) {
      const owners = choice.entries
        .filter((one) => one.flags.some((flag) => flag.field === stray))
        .map((one) => formatFlagToGive(one.selector))
        .join(" or ");
      throw new UsageError(
        `${formatFlagToGive(stray)} is for ${owners}; it cannot be given with ${formatFlagToGive(entry.selector)}`,
        help,
      );
    }
    for (const field of others) unpicked.add(field);
    payload[choice.field] = { ...entry.fixed, ...(payload[choice.field] as object) };
  }
  return unpicked;
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
    // A list with one fixed order has no sort fields, so `--sort` is an
    // unknown flag there.
    if (command.paged && command.sortFields.length > 0 && name === "sort") {
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
      help,
    );
  }

  // A flag with a default takes it when the command line left the flag out.
  for (const field of [...command.payload, ...command.query]) {
    const into = field.carriedIn === "payload" ? payload : query;
    if (field.defaultText !== undefined && readGivenValue(into, field) === undefined) {
      assignFieldValue(into, field, parseWrittenValue(field, field.defaultText, help), help);
    }
  }

  // The flags of an entry that was not picked are ignored from here on: they
  // are neither required nor read from stdin.
  const unpicked = pickEntries(command, payload, marked, help);
  const given = command.payload.filter((field) => !unpicked.has(field));

  // A required content field is always read; an optional one only when its
  // marker was given, so an empty pipe never clears a field nobody named.
  const reading = given.filter((field) => field.stdin && (!field.optional || marked.has(field)));

  // Check everything that argv alone can decide before reading the pipe, so a
  // command line that cannot work does not consume stdin first.
  // A list positional is always the last, and takes every word left, one
  // or more.
  const takesList = command.positionals.at(-1)?.repeated === true;
  const required = command.positionals.filter((field) => !field.optional).length;
  if (
    takesList
      ? positionals.length < required
      : positionals.length < required || positionals.length > command.positionals.length
  ) {
    const expected = command.positionals.map(formatPositionalShape).join(" ");
    const count =
      required === command.positionals.length
        ? String(required)
        : `${required} to ${command.positionals.length}`;
    throw new UsageError(
      `${help} takes ${count}${takesList ? " or more" : ""} argument(s): ${expected || "none"}`,
      help,
    );
  }

  checkPaging(command, { limit, cursor, sort }, help);

  const missing = given
    .filter(
      (field) =>
        !field.optional && readGivenValue(payload, field) === undefined && !reading.includes(field),
    )
    .map(formatFlagToGive);
  if (missing.length > 0) {
    throw new UsageError(`missing required ${missing.join(", ")}`, help);
  }

  // An image or a context given on the command line can be the whole input, so
  // a terminal is not waited on for text.
  const hasOtherInput = command.payload.some(
    (field) => field.standsInForStdin && field.name in payload,
  );
  if (reading.length > 0 && hasOtherInput && stdinIsTerminal) {
    for (const field of reading) setGivenValue(payload, field, coerceFieldValue(field, "", help));
  } else if (reading.length > 0) {
    // Strip one trailing newline, because heredocs and editors add one. Files
    // saved on Windows end with `\r\n`, which counts as that newline.
    const text = (await readStdin()).replace(/\r?\n$/, "");
    if (reading.length === 1) {
      const field = reading[0]!;
      setGivenValue(payload, field, coerceFieldValue(field, text, help));
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
        setGivenValue(payload, field, coerceFieldValue(field, lines[index]!, help));
      });
    }
  }

  return { positionals, payload, query, limit, cursor, sort, all, json, setupToken };
};
