/**
 * The command tree.
 *
 * A command combines the spelling the contract's CLI table gives one
 * operation with what the operation's schemas say about its fields. The table
 * decides which commands exist and how they are spelled; the schemas decide
 * each field's type, because the type is the only thing that is always
 * correct about a field. Nothing here is specific to one operation.
 *
 * The schema reading is deliberately shallow. A field has one of five types
 * (string, number, boolean, a list of one of those, or anything else, which is
 * given as JSON), and that is enough for every operation in the API. A deeper
 * mapping would be a schema-to-flags compiler nobody asked for. The one
 * exception the table opts into is a record of text values, given as
 * repeated `--<flag> <field>=<value>` (see `namedValues` on the row).
 */
import {
  CLI,
  OPERATIONS,
  api,
  readShorthandDecoder,
  readSortFields,
  type CliRow,
  type ErrorCode,
  type CliExample,
  type FieldRow,
  type Method,
  type OperationId,
  type Requirement,
} from "@hercule/contract";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";

/**
 * How a flag's or positional's text is converted into a value. A
 * `namedValues` field converts each use of its flag into one entry of an
 * object, written `<field>=<value>`.
 */
export type FieldKind = "string" | "number" | "boolean" | "json" | "namedValues";

/** The part of the request a field's value is sent in. */
export type FieldCarrier = "path" | "payload" | "query";

export interface Field {
  /** The name the API knows the field by. */
  readonly name: string;
  /** The word after `--`, or the word inside `<>` for a positional. */
  readonly spelling: string;
  /** Whether the field is a positional argument rather than a flag. */
  readonly positional: boolean;
  /** Where the value is sent: the route, the body, or the query string. */
  readonly carriedIn: FieldCarrier;
  readonly kind: FieldKind;
  /**
   * Decodes the word a person types into the value the API expects, for a
   * field whose schema has a shorthand. `undefined` for every other field,
   * where the typed text is the value.
   */
  readonly decodeShorthand: ((text: string) => unknown) | undefined;
  /**
   * Whether the field takes a list, or named values. A flag may then be given
   * more than once, and a positional, which is always the last one, takes one
   * or more words.
   */
  readonly repeated: boolean;
  readonly optional: boolean;
  /** Whether the field accepts `null`, which is written `--field null` on the command line. */
  readonly nullable: boolean;
  /** The closed set of accepted values, when the schema declares one. */
  readonly choices: ReadonlyArray<string> | undefined;
  /**
   * Whether the field holds a Hercule id. The schema decides: the field's
   * type is the contract's `Id`, not a name or free text that happens to be in
   * a field called `ownerId`.
   */
  readonly holdsAnId: boolean;
  /** Whether the value is read from stdin; there is no flag that takes it inline. */
  readonly stdin: boolean;
  /**
   * Whether each value given is the path of an image file, which the CLI
   * uploads before the call and replaces with the returned attachment id.
   */
  readonly uploads: boolean;
  /**
   * The list operation that resolves an id tail given here; absent when only a
   * full id is accepted.
   */
  readonly resolves: OperationId | undefined;
  /**
   * The query sent to the list operation in `resolves`, such as `{ view:
   * "later" }` to match a tail among the snoozed signals; empty when the
   * listing's default holds the ids this field takes.
   */
  readonly resolvesQuery: Readonly<Record<string, string>>;
  readonly help: string;
}

/** What an operation returns, as the help describes it. */
export interface Returns {
  /** The top-level field names of the success schema; empty when it is a bare list. */
  readonly fields: ReadonlyArray<string>;
  /** The fields of one item, when the result is a page or a bare list. */
  readonly items: ReadonlyArray<string> | undefined;
}

export interface Command {
  readonly id: OperationId;
  /** The words after `hercule`, in tree order. */
  readonly words: ReadonlyArray<string>;
  /** The same words as one string, which messages and help use to name the command. */
  readonly spelling: string;
  readonly requires: Requirement;
  readonly method: Method;
  readonly path: string;
  /**
   * The positional fields, in order: the path parameters in route order, then
   * any payload field the table makes positional.
   */
  readonly positionals: ReadonlyArray<Field>;
  /** The payload fields given as `--<flag>`; payload positionals are not included. */
  readonly payload: ReadonlyArray<Field>;
  /** The query fields other than the three paging fields, given as `--<flag>`. */
  readonly query: ReadonlyArray<Field>;
  /**
   * Whether the operation is paged, so `--limit`, `--cursor` and `--all`
   * apply, and `--sort` when it has sort fields.
   */
  readonly paged: boolean;
  /**
   * The fields `--sort` accepts, when the operation pages. Empty for a list
   * with one fixed order, which takes no `--sort`.
   */
  readonly sortFields: ReadonlyArray<string>;
  /**
   * The contract's schema for the three paging parameters, taken from the
   * operation's query schema. `undefined` when the operation does not page.
   */
  readonly pageQuery: Schema.Codec<unknown, unknown> | undefined;
  readonly help: string;
  readonly examples: ReadonlyArray<CliExample>;
  /** The error codes the endpoint declares, in the order it declares them. */
  readonly codes: ReadonlyArray<ErrorCode>;
  /** What an error code means for this operation, when the generic meaning is not enough. */
  readonly meanings: Partial<Record<ErrorCode, string>>;
  readonly returns: Returns;
}

/**
 * The three paging fields every `query` operation has. They are handled by
 * name, not as field flags.
 */
const PAGE_FIELDS = new Set(["limit", "cursor", "sort"]);

type Ast = {
  readonly _tag: string;
  readonly checks?: ReadonlyArray<{ readonly annotations?: { readonly title?: unknown } }>;
  readonly types?: ReadonlyArray<Ast>;
  readonly rest?: ReadonlyArray<Ast>;
  readonly literal?: unknown;
  readonly context?: { readonly isOptional?: boolean };
  readonly propertySignatures?: ReadonlyArray<{ readonly name: PropertyKey; readonly type: Ast }>;
  readonly indexSignatures?: ReadonlyArray<{ readonly parameter: Ast; readonly type: Ast }>;
  readonly typeParameters?: ReadonlyArray<Ast>;
};

/**
 * Returns the string literals of a literal or a union of literals, or
 * `undefined` for any other type.
 */
const readStringLiterals = (ast: Ast): ReadonlyArray<string> | undefined => {
  if (ast._tag === "Literal") return typeof ast.literal === "string" ? [ast.literal] : undefined;
  if (ast._tag !== "Union" || ast.types === undefined) return undefined;
  const literals: Array<string> = [];
  for (const member of ast.types) {
    if (member._tag !== "Literal" || typeof member.literal !== "string") return undefined;
    literals.push(member.literal);
  }
  return literals;
};

/**
 * Returns `X` for a type `X | null`, and any other type unchanged. A nullable
 * field still has the type of its other values; only clearing it is
 * different, and on the command line that is `--field null`.
 */
const stripNull = (ast: Ast): Ast => {
  if (ast._tag !== "Union" || ast.types === undefined) return ast;
  const present = ast.types.filter((member) => member._tag !== "Null");
  return present.length === 1 ? present[0]! : ast;
};

/** Checks whether the type allows `null`. */
const isNullable = (ast: Ast): boolean =>
  ast._tag === "Union" &&
  ast.types !== undefined &&
  ast.types.some((member) => member._tag === "Null");

/**
 * Returns the element type of a field that holds a list, or `undefined` for a
 * field that holds a single value.
 *
 * A filter typed `X | X[]` becomes the same repeatable flag as a plain `X[]`.
 * The single-value member exists so an API caller may send one value; on the
 * command line, giving the flag once does the same.
 */
const readElementType = (input: Ast): Ast | undefined => {
  const ast = stripNull(input);
  if (ast._tag === "Arrays") return ast.rest?.[0];
  if (ast._tag !== "Union" || ast.types === undefined) return undefined;
  const list = ast.types.find((member) => member._tag === "Arrays");
  return list?.rest?.[0];
};

/**
 * The title of the contract's `Id` schema. Every id in the API is a UUIDv7,
 * so a schema with this title is the only type that holds a Hercule id.
 */
const UUID = "uuidv7";

/**
 * Checks whether a field holds a Hercule id. The schema decides, not the field
 * name: a secret's `ownerId` holds a plugin's name. A tail can only stand for
 * a full UUID. A field that takes an id or a word in its place, such as `me`,
 * holds an id too.
 */
const holdsAnId = (input: Ast): boolean => {
  const ast = stripNull(input);
  if (ast._tag === "Union" && ast.types !== undefined) return ast.types.some(holdsAnId);
  return (ast.checks ?? []).some((check) => check.annotations?.title === UUID);
};

const readScalarKind = (input: Ast): FieldKind => {
  const ast = stripNull(input);
  if (readStringLiterals(ast) !== undefined) return "string";
  // An id or the word `me` in its place is text either way.
  if (
    ast._tag === "Union" &&
    ast.types !== undefined &&
    ast.types.every((member) => readScalarKind(member) === "string")
  ) {
    return "string";
  }
  switch (ast._tag) {
    case "String":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "boolean";
    default:
      return "json";
  }
};

/**
 * Checks whether the type is a record from text to text, such as
 * `Record<string, string>`, with no named properties and no `null`. Checks on
 * the keys, the values or the whole record are allowed; the API applies them.
 */
const isRecordOfText = (ast: Ast): boolean =>
  ast._tag === "Objects" &&
  (ast.propertySignatures ?? []).length === 0 &&
  ast.indexSignatures?.length === 1 &&
  ast.indexSignatures[0]!.parameter._tag === "String" &&
  ast.indexSignatures[0]!.type._tag === "String";

/** Converts a camelCase field name to kebab case: `sessionId` becomes `session-id`. */
const toKebabCase = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * Builds one field from its schema type and its CLI row.
 *
 * `schema` is the field's own schema, when the operation declares one; the
 * shorthand decoder is read from it. Everything else comes from the AST.
 */
const buildField = (
  name: string,
  ast: Ast,
  row: Exclude<FieldRow, { readonly hidden: true }>,
  carriedIn: FieldCarrier,
  schema: unknown,
): Field => {
  const element = readElementType(ast);
  const value = element ?? ast;
  const takesNamedValues = "namedValues" in row;
  // A positional uses the row's placeholder when its own name would not say
  // whose id it is; a flag always uses the row's spelling.
  const spelling = "flag" in row ? row.flag : (row.placeholder ?? toKebabCase(name));
  return {
    name,
    spelling,
    positional: "positional" in row,
    carriedIn,
    kind: takesNamedValues ? "namedValues" : readScalarKind(value),
    decodeShorthand: readShorthandDecoder(schema),
    // A list takes one value per use of its flag, and so does a field that
    // takes named values: each `--<flag> <field>=<value>` adds one entry.
    repeated: element !== undefined || takesNamedValues,
    // A row can make a field required on the command line even when the
    // operation's schema makes it optional. This is for a field that is the
    // only way to pass its value on the command line.
    optional: ast.context?.isOptional === true && !("required" in row && row.required === true),
    nullable: isNullable(ast) || isNullable(value),
    choices: readStringLiterals(stripNull(value)),
    holdsAnId: holdsAnId(value),
    stdin: "stdin" in row && row.stdin === true,
    uploads: "upload" in row && row.upload === true,
    resolves: "resolves" in row ? row.resolves : undefined,
    resolvesQuery: ("resolvesQuery" in row ? row.resolvesQuery : undefined) ?? {},
    help: row.help,
  };
};

/**
 * Builds every field of one schema, except the three paging fields: `--limit`,
 * `--cursor` and `--sort` are handled by name everywhere and have no row.
 *
 * - A field with no row is missing from the contract's CLI table, so this
 *   throws rather than creating a flag with no name.
 * - A field whose row is hidden gets no flag.
 * - A query field whose row makes it positional throws, because the table is
 *   wrong.
 * - A field whose row asks for named values throws when its schema is not a
 *   record of text values, or when the row also makes it positional,
 *   because the table is wrong.
 */
const buildFields = (
  id: OperationId,
  schema: unknown,
  rows: Record<string, FieldRow>,
  carriedIn: FieldCarrier,
): ReadonlyArray<Field> => {
  const struct = schema as
    | { ast?: Ast; fields?: Record<string, unknown>; schema?: { fields?: Record<string, unknown> } }
    | undefined;
  // A query parameter schema is wrapped in the codec that reads a query
  // string, so for a query the struct with the field schemas is one level
  // down.
  const fields = struct?.fields ?? struct?.schema?.fields;
  const ast = struct?.ast;
  if (ast?.propertySignatures === undefined) return [];
  return ast.propertySignatures
    .map((property) => [String(property.name), property.type] as const)
    .filter(([name]) => !PAGE_FIELDS.has(name))
    .flatMap(([name, type]) => {
      const row = rows[name];
      if (row === undefined) throw new Error(`${id}: ${name} has no row`);
      if ("hidden" in row) return [];
      // A positional is a route parameter or a payload field. A positional
      // query parameter would be parsed and then sent nowhere, so the table
      // is wrong, and this says so.
      if (carriedIn === "query" && "positional" in row) {
        throw new Error(`${id}: ${name} is a query parameter and cannot be a bare word`);
      }
      // A field that takes named values is repeatable. As a bare word it
      // would take every word after it, so the table is wrong.
      if ("namedValues" in row && "positional" in row) {
        throw new Error(`${id}: ${name} takes named values, so it must be a flag, not a bare word`);
      }
      if ("namedValues" in row && !isRecordOfText(type)) {
        throw new Error(
          `${id}: ${name} takes named values, but its schema is not a record of text`,
        );
      }
      return [buildField(name, type, row, carriedIn, fields?.[name])];
    });
};

/** Returns the payload schema, which is one level deeper: inside a map from media type to codec. */
const readPayloadSchema = (payload: unknown): unknown => {
  if (!(payload instanceof Map)) return undefined;
  const json = payload.get("application/json") as { schemas?: ReadonlyArray<unknown> } | undefined;
  return (json?.schemas?.[0] as { schema?: unknown } | undefined)?.schema;
};

const listPropertyNames = (ast: Ast | undefined): ReadonlyArray<string> =>
  (ast?.propertySignatures ?? []).map((property) => String(property.name));

/** Returns what the success schema describes: a record, a page of records, or a bare list. */
const readReturns = (success: unknown): Returns => {
  const ast = [...((success as Set<{ ast?: Ast }> | undefined) ?? [])][0]?.ast;
  if (ast === undefined) return { fields: [], items: undefined };
  if (ast._tag === "Arrays") {
    return { fields: [], items: listPropertyNames(ast.rest?.[0]) };
  }
  const fields = listPropertyNames(ast);
  const page = ast.propertySignatures?.find((property) => String(property.name) === "items");
  return { fields, items: page === undefined ? undefined : listPropertyNames(page.type.rest?.[0]) };
};

/**
 * Returns the error codes an endpoint declares. Each declared error is the
 * envelope struct wrapped in a class declaration, so the code is the literal
 * type of the `error.code` field.
 */
const listErrorCodes = (errors: unknown): ReadonlyArray<ErrorCode> => {
  const codes: Array<ErrorCode> = [];
  for (const error of (errors as Set<{ ast?: Ast }> | undefined) ?? []) {
    const envelope = error.ast?.typeParameters?.[0];
    const code = envelope?.propertySignatures
      ?.find((property) => String(property.name) === "error")
      ?.type.propertySignatures?.find((property) => String(property.name) === "code");
    if (typeof code?.type.literal === "string") codes.push(code.type.literal as ErrorCode);
  }
  return codes;
};

/**
 * Returns the schema of the paging parameters in an operation's query schema,
 * or `undefined` when the operation does not page. A list with one fixed
 * order, such as `signal.query`'s views, has `limit` and `cursor` but no
 * `sort`. The schemas are the contract's own, so the CLI checks a paging flag
 * by the same rules as the API, without restating any of them.
 */
const readPageQuery = (query: unknown): Schema.Codec<unknown, unknown> | undefined => {
  // The query schema is wrapped in the codec that reads a query string, so the
  // struct with the field schemas is one level down, as in `buildFields`.
  const fields = (
    query as {
      readonly schema?: { readonly fields?: Record<string, Schema.Codec<unknown, unknown>> };
    }
  )?.schema?.fields;
  if (fields?.["limit"] === undefined) return undefined;
  const limit = fields["limit"];
  const cursor = fields["cursor"]!;
  const sort = fields["sort"];
  return sort === undefined
    ? Schema.Struct({ limit, cursor })
    : Schema.Struct({ limit, cursor, sort });
};

/** Returns the `:name` path parameters of a route, in order. */
const listPathParams = (path: string): ReadonlyArray<string> =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);

/** The CLI table, typed by its row type rather than by its literal type. */
const TABLE: Record<OperationId, CliRow> = CLI;

/** Builds every visible command from the API and the CLI table. Throws when the two disagree. */
const buildCommands = (): ReadonlyArray<Command> => {
  const commands: Array<Command> = [];

  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group }) => {
      const id = `${group.identifier}.${endpoint.identifier}` as OperationId;
      const row = TABLE[id];
      if ("hidden" in row) return;

      const operation = OPERATIONS[id];
      const each = endpoint as {
        params?: unknown;
        query?: unknown;
        payload?: unknown;
        success?: unknown;
        error?: unknown;
      };
      const payloadSchema = readPayloadSchema(each.payload);
      // A row that lists a field the operation does not have is out of date,
      // hidden or not. Throw here, as `buildFields` throws for a field with no
      // row, so the CLI table and the schemas always list the same fields.
      const taken = new Set(
        [each.params, payloadSchema, each.query].flatMap((schema) =>
          listPropertyNames((schema as { ast?: Ast } | undefined)?.ast),
        ),
      );
      const stale = Object.keys(row.fields).find((name) => !taken.has(name));
      if (stale !== undefined) {
        throw new Error(
          `${id}: the CLI row lists the field ${stale}, but the operation has no such field`,
        );
      }

      const params = new Map(
        buildFields(id, each.params, row.fields, "path").map((field) => [field.name, field]),
      );
      const payload = buildFields(id, payloadSchema, row.fields, "payload");
      const query = buildFields(id, each.query, row.fields, "query");
      const inPath = listPathParams(operation.path);
      // A route parameter the params schema does not declare is a mistake in
      // the contract, not a string: the CLI would send a value nothing
      // decodes. Payload positionals come after the route parameters, so a
      // command whose only argument is its content takes it as a positional,
      // not as a flag.
      const positionals = [
        ...inPath.map((name) => params.get(name)!),
        ...payload.filter((field) => field.positional),
      ];
      // A list positional takes every word left, so a positional after it
      // could never be given.
      const early = positionals.slice(0, -1).find((field) => field.repeated);
      if (early !== undefined) {
        throw new Error(`${id}: ${early.name} takes a list, so it must be the last positional`);
      }

      commands.push({
        id,
        words: row.command.split(" "),
        spelling: row.command,
        requires: operation.requires,
        method: operation.method,
        path: operation.path,
        positionals,
        payload: payload.filter((field) => !field.positional),
        query,
        // `limit` and `cursor` always come together, and `sort` comes with
        // them unless the list has one fixed order, so `limit` alone shows
        // that the operation is paged.
        paged: listPropertyNames((each.query as { ast?: Ast } | undefined)?.ast).includes("limit"),
        sortFields: readSortFields(each.query),
        pageQuery: readPageQuery(each.query),
        help: row.help,
        examples: row.examples,
        codes: listErrorCodes(each.error),
        meanings: row.errors ?? {},
        returns: readReturns(each.success),
      });
    },
  });

  return commands;
};

/** Every visible command, in the contract's order. */
export const COMMANDS: ReadonlyArray<Command> = buildCommands();

/**
 * Joins words into a map key that no single word can match, so `hercule "task
 * list"` is not a command.
 */
const buildWordsKey = (words: ReadonlyArray<string>): string => words.join("\u0000");

const BY_WORDS = new Map(COMMANDS.map((command) => [buildWordsKey(command.words), command]));

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

/** Returns the command spelled by exactly these words, or `undefined`. */
export const findCommandByWords = (words: ReadonlyArray<string>): Command | undefined =>
  BY_WORDS.get(buildWordsKey(words));

/** Returns the command of an operation id, or `undefined` for a hidden operation. */
export const findCommandById = (id: OperationId): Command | undefined => BY_ID.get(id);

/** Returns every command whose words start with this prefix, in the contract's order. */
export const listCommandsUnder = (prefix: ReadonlyArray<string>): ReadonlyArray<Command> =>
  COMMANDS.filter(
    (command) =>
      command.words.length > prefix.length &&
      prefix.every((word, index) => command.words[index] === word),
  );

/**
 * Returns the words that may follow this prefix, in the contract's order: the
 * nouns at the root, and a noun's verbs and nested nouns below it. Returns an
 * empty list when the prefix is not in the tree, which is how an unknown word
 * is detected.
 */
export const listWordsAfter = (prefix: ReadonlyArray<string>): ReadonlyArray<string> => {
  const next: Array<string> = [];
  for (const command of listCommandsUnder(prefix)) {
    const word = command.words[prefix.length]!;
    if (!next.includes(word)) next.push(word);
  }
  return next;
};

/**
 * The hand-written commands, which have no CLI row. Help text may mention
 * them, and `findMentions` must not treat them as unknown.
 */
const HAND_WRITTEN = ["login", "setup-url", "service", "serve"];

/** One `hercule ...` mentioned in a text, looked up in the tree. */
export interface Mention {
  /** The words after `hercule` in the text. */
  readonly words: ReadonlyArray<string>;
  /**
   * The longest run of leading words that is in the tree. `undefined` when
   * none of them is, or when the text continues after a run that is only a
   * noun rather than a whole command, which looks like a misspelling.
   */
  readonly names: string | undefined;
  /** The command those words spell; `undefined` when they are only a noun. */
  readonly command: Command | undefined;
}

/**
 * Returns every `hercule ...` mentioned in a text. The help and the CLI table's
 * tests both use this one function, so the commands the help suggests next
 * and the mentions the tests accept always agree.
 *
 * A flag, a `<placeholder>` or any other punctuation ends a mention, and text
 * that continues after a whole command ("hercule task list to find work")
 * keeps the command.
 */
export const findMentions = (text: string): ReadonlyArray<Mention> =>
  [...text.matchAll(/\bhercule((?:\s+[a-z][a-z-]*)+)/g)].map((match) => {
    const words = match[1]!.trim().split(/\s+/);
    for (let length = words.length; length > 0; length -= 1) {
      const run = words.slice(0, length);
      const named = run.join(" ");
      const command = findCommandByWords(run);
      const whole = command !== undefined || HAND_WRITTEN.includes(named);
      if (!whole && listWordsAfter(run).length === 0) continue;
      if (length === words.length || whole) return { words, names: named, command };
      break;
    }
    return { words, names: undefined, command: undefined };
  });
