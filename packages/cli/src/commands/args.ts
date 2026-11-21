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
import { groupFieldsBySpelling, type Command, type Field } from "./tree";

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
export const formatFlagToGive = (field: Field): string =>
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
        throw new UsageError(`${formatFieldName(field)}: ${text} is not valid JSON`, help);
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
    : (given[field.within.field] as Record<string, unknown> | undefined)?.[field.name];

/**
 * Sets the value of a field in the request part `into`. A flag that fills one
 * key of an object field sets that key in a copy of the object, which starts
 * as the object's fixed values when no other flag has made it yet.
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
  const object = (into[field.within.field] ?? field.within.fixed) as Record<string, unknown>;
  into[field.within.field] = { ...object, [field.name]: value };
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
 * Picks the entry of each `oneOf` field that the flags given stand for, and
 * returns the fields of the entries not picked. Throws a `UsageError` when
 * the flags of two entries are given, when no flag picks an entry, or when a
 * flag is given that the picked entry does not declare.
 *
 * `touched` holds the fields of the entries that a flag was given for, or
 * whose `--<flag>-stdin` marker was. A flag that several entries declare
 * picks none of them, so only the flags one entry alone declares count.
 */
const pickEntries = (
  command: Command,
  touched: ReadonlySet<Field>,
  help: string,
): ReadonlySet<Field> => {
  const unpicked = new Set<Field>();
  for (const choice of command.choices) {
    const owned = choice.entries.map((entry) =>
      entry.fields.filter((field) =>
        choice.entries.every(
          (other) =>
            other === entry || !other.fields.some((one) => one.spelling === field.spelling),
        ),
      ),
    );
    const given = owned.map((fields) => fields.filter((field) => touched.has(field)));
    const picked = given.flatMap((fields, index) => (fields.length > 0 ? [index] : []));
    // The flags to give for each entry: the ones it requires, or if it
    // requires none, the ones only it declares.
    const toGive = choice.entries
      .map((entry, index) => {
        const required = entry.fields.filter((field) => !field.optional);
        return required.length > 0
          ? required.map(formatFlagToGive).join(" and ")
          : owned[index]!.map(formatFlagToGive).join(" or ");
      })
      .join(", or ");
    if (picked.length === 0) {
      throw new UsageError(`no flag says which form to use: give ${toGive}`, help);
    }
    if (picked.length > 1) {
      const earlier = given[picked[0]!]!.map(formatFlagToGive).join(" or ");
      const later = picked
        .slice(1)
        .flatMap((index) => given[index]!)
        .map(formatFlagToGive)
        .join(" or ");
      throw new UsageError(`${later} cannot be given with ${earlier}: give ${toGive}`, help);
    }
    const pickedEntry = choice.entries[picked[0]!]!;
    // A flag that several entries declare picks none of them, so the picked
    // entry may not declare it. Taking it without a word would drop what the
    // user typed.
    const stray = [...touched].find(
      (field) =>
        choice.entries.some((entry) => entry.fields.includes(field)) &&
        !pickedEntry.fields.some((one) => one.spelling === field.spelling),
    );
    if (stray !== undefined) {
      const picking = given[picked[0]!]!.map(formatFlagToGive).join(" or ");
      throw new UsageError(
        `${formatFlagToGive(stray)} cannot be given with ${picking}: that form has no ${formatFlagToGive(stray)}. Give ${toGive}`,
        help,
      );
    }
    for (const [index, entry] of choice.entries.entries()) {
      if (index !== picked[0]) for (const field of entry.fields) unpicked.add(field);
    }
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
  const payloadFields = groupFieldsBySpelling(command.payload);
  const queryFields = groupFieldsBySpelling(command.query);

  const positionals: Array<string> = [];
  const payload: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const marked = new Set<Field>();
  // The fields of `oneOf` entries that a flag or a marker was given for, and
  // the values given. They wait until an entry is picked, because the same
  // flag may belong to an entry that is not.
  const touched = new Set<Field>();
  const entryValues = new Map<Field, unknown>();
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
      const fields = payloadFields.get(name.slice(0, -"-stdin".length));
      if (fields === undefined || !fields[0]!.stdin) {
        throw new UsageError(`unknown flag --${name}`, help);
      }
      // The marker only asks for the read. It never takes the value, or the
      // value would be back in `argv`, which reading stdin exists to avoid.
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`, help);
      for (const field of fields) {
        marked.add(field);
        if (field.within !== undefined) touched.add(field);
      }
      continue;
    }

    const payloadGiven = payloadFields.get(name);
    const fields = payloadGiven ?? queryFields.get(name);
    if (fields === undefined) throw new UsageError(`unknown flag --${name}`, help);
    const field = fields[0]!;
    if (field.stdin) {
      throw new UsageError(
        `--${name} does not exist: ${command.id} reads ${field.name} from stdin, never from argv, where it would show in process lists and in shell history. Pipe it in; --${name}-stdin ${field.optional ? "tells the CLI to read it" : "is accepted but not needed"}.`,
        help,
      );
    }
    const text = value();
    for (const each of fields) {
      const parsed = parseWrittenValue(each, text, help);
      if (each.within === undefined) {
        assignFieldValue(payloadGiven === undefined ? query : payload, each, parsed, help);
      } else {
        touched.add(each);
        entryValues.set(each, parsed);
      }
    }
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
  const unpicked = pickEntries(command, touched, help);
  for (const [field, value] of entryValues) {
    if (!unpicked.has(field)) setGivenValue(payload, field, value);
  }
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
