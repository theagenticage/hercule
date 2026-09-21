/**
 * The command tree.
 *
 * A command is the spelling the contract's CLI table writes for one operation,
 * joined with what the operation's schemas say about its fields. The table
 * decides what exists and how it is spelled; the schemas decide what shape each
 * field has, because the type is the only place that can stay true about it.
 * Nothing per-operation is written here.
 *
 * The AST walk is deliberately shallow. A field is one of five shapes - string,
 * number, boolean, a list of one of those, or anything else, which arrives as
 * JSON - and that is enough for every operation in the API. A deeper mapping
 * would be a schema-to-flags compiler nobody asked for.
 */
import {
  CLI,
  OPERATIONS,
  api,
  readShorthandDecoder,
  sortFieldsOf,
  type CliRow,
  type ErrorCode,
  type CliExample,
  type FieldRow,
  type Method,
  type OperationId,
  type Requirement,
} from "@hercule/contract";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";

/** How a flag's or positional's text becomes a value. */
export type FieldKind = "string" | "number" | "boolean" | "json";

/** Which half of the request a field's value travels in. */
export type FieldCarrier = "path" | "payload" | "query";

export interface Field {
  /** The name the API knows the field by. */
  readonly name: string;
  /** The word after `--`, or the word inside `<>` for a positional. */
  readonly spelling: string;
  /** The field is written as a bare word in its place, not as a flag. */
  readonly positional: boolean;
  /** Where the value travels: the route, the body, or the query string. */
  readonly carriedIn: FieldCarrier;
  readonly kind: FieldKind;
  /**
   * Decodes the one word a person writes into the value the wire carries, for
   * a field whose schema carries a shorthand. `undefined` where the written
   * text is the value, which is every other field.
   */
  readonly decodeShorthand: ((text: string) => unknown) | undefined;
  /** The flag may be given more than once; the values become a list. */
  readonly repeated: boolean;
  readonly optional: boolean;
  /** The field accepts `null`, which on the command line is written `--field null`. */
  readonly nullable: boolean;
  /** The closed set of accepted values, when the schema declares one. */
  readonly choices: ReadonlyArray<string> | undefined;
  /**
   * Whether the field holds a Hercule id. The answer comes from the schema: the
   * field is the contract's `Id`, and not a name or a free word that happens
   * to sit in a field called `ownerId`.
   */
  readonly holdsAnId: boolean;
  /** The value arrives on stdin; there is no inline flag for it. */
  readonly stdin: boolean;
  /** The listing an id tail written here is resolved through; absent takes a full id. */
  readonly resolves: OperationId | undefined;
  readonly help: string;
}

/** What comes back, as the help renderer says it. */
export interface Returns {
  /** The success schema's top-level field names; empty when it is a bare list. */
  readonly fields: ReadonlyArray<string>;
  /** The fields of one item, when the success is a page or a bare list. */
  readonly items: ReadonlyArray<string> | undefined;
}

export interface Command {
  readonly id: OperationId;
  /** The words after `hercule`, in tree order. */
  readonly words: ReadonlyArray<string>;
  /** The same words as one string, which is how a message and a help line name a command. */
  readonly spelling: string;
  readonly requires: Requirement;
  readonly method: Method;
  readonly path: string;
  /**
   * The fields given as bare words, in the order the command takes them: the
   * path parameters in route order, then any payload field the table writes as
   * a bare word.
   */
  readonly positionals: ReadonlyArray<Field>;
  /** Payload fields given as `--<flag>`; a payload positional is not among them. */
  readonly payload: ReadonlyArray<Field>;
  /** Query fields other than the pagination triple; given as `--<flag>`. */
  readonly query: ReadonlyArray<Field>;
  /** The operation pages: `--limit`, `--cursor`, `--sort`, `--all` apply. */
  readonly paged: boolean;
  /** The fields `--sort` accepts, when the operation pages. */
  readonly sortFields: ReadonlyArray<string>;
  readonly help: string;
  readonly examples: ReadonlyArray<CliExample>;
  /** The error codes the endpoint declares, in the order it declares them. */
  readonly codes: ReadonlyArray<ErrorCode>;
  /** What a code means on this operation, where the generic line does not say enough. */
  readonly meanings: Partial<Record<ErrorCode, string>>;
  readonly returns: Returns;
}

/** The pagination triple every `query` operation carries; handled by name, not as flags. */
const PAGE_FIELDS = new Set(["limit", "cursor", "sort"]);

type Ast = {
  readonly _tag: string;
  readonly checks?: ReadonlyArray<{ readonly annotations?: { readonly title?: unknown } }>;
  readonly types?: ReadonlyArray<Ast>;
  readonly rest?: ReadonlyArray<Ast>;
  readonly literal?: unknown;
  readonly context?: { readonly isOptional?: boolean };
  readonly propertySignatures?: ReadonlyArray<{ readonly name: PropertyKey; readonly type: Ast }>;
  readonly typeParameters?: ReadonlyArray<Ast>;
};

/** The string literals a union is made of, or `undefined` when it is not one. */
const literalsOf = (ast: Ast): ReadonlyArray<string> | undefined => {
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
 * What is left of `X | null` once the null is taken away. A nullable field is
 * still the shape it holds; only the way it is cleared is different, and on the
 * command line that is `--field null`.
 */
const withoutNull = (ast: Ast): Ast => {
  if (ast._tag !== "Union" || ast.types === undefined) return ast;
  const present = ast.types.filter((member) => member._tag !== "Null");
  return present.length === 1 ? present[0]! : ast;
};

/** Whether `null` is one of the values this field holds. */
const isNullable = (ast: Ast): boolean =>
  ast._tag === "Union" && ast.types !== undefined && ast.types.some((m) => m._tag === "Null");

/**
 * The element of a field that holds several values, or `undefined` for one that
 * holds a single value.
 *
 * A filter written `X | X[]` is the same repeatable flag as a plain `X[]`: the
 * one-value member exists so a caller may send a scalar, and on a command line
 * repeating the flag is how that choice is made.
 */
const elementOf = (input: Ast): Ast | undefined => {
  const ast = withoutNull(input);
  if (ast._tag === "Arrays") return ast.rest?.[0];
  if (ast._tag !== "Union" || ast.types === undefined) return undefined;
  const list = ast.types.find((member) => member._tag === "Arrays");
  return list?.rest?.[0];
};

/**
 * The title the contract puts on its `Id` schema. Every id on the wire is a
 * uuidv7, so a schema with this title is the one shape that holds a Hercule id.
 */
const UUID = "uuidv7";

/**
 * Whether this field holds a Hercule id. The schema answers, not the field name:
 * a secret's `ownerId` holds a plugin's name. A tail can stand for a canonical
 * UUID and for nothing else.
 */
const holdsAnId = (input: Ast): boolean =>
  (withoutNull(input).checks ?? []).some((check) => check.annotations?.title === UUID);

const scalarKind = (input: Ast): FieldKind => {
  const ast = withoutNull(input);
  if (literalsOf(ast) !== undefined) return "string";
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

/** `sessionId` on the wire is `<session-id>` on the command line. */
const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * The shape of one field, as the schema has it and the row spells it.
 *
 * `schema` is the field's own schema where the operation declares one, which is
 * what a shorthand is read from. The AST alone answers everything else.
 */
const buildField = (
  name: string,
  ast: Ast,
  row: FieldRow,
  carriedIn: FieldCarrier,
  schema: unknown,
): Field => {
  const element = elementOf(ast);
  const value = element ?? ast;
  // A positional is spelled by the row where its own name would not say whose
  // id it is; a flag is always spelled by the row.
  const spelling = "flag" in row ? row.flag : (row.placeholder ?? kebab(name));
  return {
    name,
    spelling,
    positional: "positional" in row,
    carriedIn,
    kind: scalarKind(value),
    decodeShorthand: readShorthandDecoder(schema),
    repeated: element !== undefined,
    optional: ast.context?.isOptional === true,
    nullable: isNullable(ast) || isNullable(value),
    choices: literalsOf(withoutNull(value)),
    holdsAnId: holdsAnId(value),
    stdin: "stdin" in row && row.stdin === true,
    resolves: "resolves" in row ? row.resolves : undefined,
    help: row.help,
  };
};

/**
 * Every field of one schema, the paging triple left out: `--limit`, `--cursor`
 * and `--sort` are handled by name everywhere and so have no row. A field the
 * table does not write is a row missing from the contract, and it is said here
 * rather than rendered as a nameless flag.
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
  // A query parameter set arrives wrapped in the codec that reads a query
  // string, so the struct holding the field schemas is one level down there.
  const fields = struct?.fields ?? struct?.schema?.fields;
  const ast = struct?.ast;
  if (ast?.propertySignatures === undefined) return [];
  return ast.propertySignatures
    .map((property) => [String(property.name), property.type] as const)
    .filter(([name]) => !PAGE_FIELDS.has(name))
    .map(([name, type]) => {
      const row = rows[name];
      if (row === undefined) throw new Error(`${id}: ${name} has no row`);
      // A bare word is a route parameter or a payload field. A query
      // parameter written as one would be parsed as a positional and then
      // sent nowhere, so the table is wrong and says so here.
      if (carriedIn === "query" && "positional" in row) {
        throw new Error(`${id}: ${name} is a query parameter and cannot be a bare word`);
      }
      return buildField(name, type, row, carriedIn, fields?.[name]);
    });
};

/** The payload schema hides one level deeper: a media-type map holding a codec. */
const buildPayloadFields = (
  id: OperationId,
  payload: unknown,
  rows: Record<string, FieldRow>,
): ReadonlyArray<Field> => {
  if (!(payload instanceof Map)) return [];
  const json = payload.get("application/json") as { schemas?: ReadonlyArray<unknown> } | undefined;
  const codec = json?.schemas?.[0] as { schema?: unknown } | undefined;
  return buildFields(id, codec?.schema, rows, "payload");
};

const propertyNames = (ast: Ast | undefined): ReadonlyArray<string> =>
  (ast?.propertySignatures ?? []).map((property) => String(property.name));

/** What the success schema answers with: a record, a page of records, or a bare list. */
const returnsOf = (success: unknown): Returns => {
  const ast = [...((success as Set<{ ast?: Ast }> | undefined) ?? [])][0]?.ast;
  if (ast === undefined) return { fields: [], items: undefined };
  if (ast._tag === "Arrays") {
    return { fields: [], items: propertyNames(ast.rest?.[0]) };
  }
  const fields = propertyNames(ast);
  const page = ast.propertySignatures?.find((property) => String(property.name) === "items");
  return { fields, items: page === undefined ? undefined : propertyNames(page.type.rest?.[0]) };
};

/**
 * The codes an endpoint can answer with. Each declared error is the envelope
 * struct wrapped in a class declaration, so the code is the literal its `error`
 * field carries.
 */
const codesOf = (errors: unknown): ReadonlyArray<ErrorCode> => {
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

/** `:name` path parameters, in the order the route writes them. */
const pathParams = (path: string): ReadonlyArray<string> =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);

/** The table, read through its row type rather than through its literal shape. */
const TABLE: Record<OperationId, CliRow> = CLI;

const build = (): ReadonlyArray<Command> => {
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
      const params = new Map(
        buildFields(id, each.params, row.fields, "path").map((field) => [field.name, field]),
      );
      const payload = buildPayloadFields(id, each.payload, row.fields);
      const query = buildFields(id, each.query, row.fields, "query");
      const inPath = pathParams(operation.path);

      commands.push({
        id,
        words: row.command.split(" "),
        spelling: row.command,
        requires: operation.requires,
        method: operation.method,
        path: operation.path,
        // A route parameter the params schema does not declare is a contract
        // mistake, not a string: the CLI would send a value nothing decodes.
        // A payload field the table writes as a bare word follows them, so a
        // command whose one argument is its content is typed as that word and
        // not as a flag.
        positionals: [
          ...inPath.map((name) => params.get(name)!),
          ...payload.filter((f) => f.positional),
        ],
        payload: payload.filter((field) => !field.positional),
        query,
        // The paging triple travels together, so the sort field is enough to
        // say the operation pages.
        paged: propertyNames((each.query as { ast?: Ast } | undefined)?.ast).includes("sort"),
        sortFields: sortFieldsOf(each.query),
        help: row.help,
        examples: row.examples,
        codes: codesOf(each.error),
        meanings: row.errors ?? {},
        returns: returnsOf(each.success),
      });
    },
  });

  return commands;
};

/** Every visible command, in the contract's own order. */
export const COMMANDS: ReadonlyArray<Command> = build();

/** A key no single word can collide with, so `hercule "task list"` is not a command. */
const keyOf = (words: ReadonlyArray<string>): string => words.join("\u0000");

const BY_WORDS = new Map(COMMANDS.map((command) => [keyOf(command.words), command]));

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

/** The command spelled by exactly these words, or `undefined`. */
export const commandAt = (words: ReadonlyArray<string>): Command | undefined =>
  BY_WORDS.get(keyOf(words));

/** The command an operation id names; `undefined` for a hidden operation. */
export const commandOf = (id: OperationId): Command | undefined => BY_ID.get(id);

/** Every command spelled under this prefix, in the contract's order. */
export const commandsUnder = (prefix: ReadonlyArray<string>): ReadonlyArray<Command> =>
  COMMANDS.filter(
    (command) =>
      command.words.length > prefix.length &&
      prefix.every((word, index) => command.words[index] === word),
  );

/**
 * The words that may follow this prefix, in the contract's order: the nouns at
 * the root, and a noun's verbs and nested nouns below it. Empty when the prefix
 * is not a node of the tree, which is what makes a word unknown.
 */
export const wordsAfter = (prefix: ReadonlyArray<string>): ReadonlyArray<string> => {
  const next: Array<string> = [];
  for (const command of commandsUnder(prefix)) {
    const word = command.words[prefix.length]!;
    if (!next.includes(word)) next.push(word);
  }
  return next;
};

/**
 * The hand-written commands, which have no row: help may name them and the
 * scanner below must not call them unknown.
 */
const HAND_WRITTEN = ["login", "setup-url", "serve"];

/** One `hercule ...` the prose named, resolved against the tree. */
export interface Mention {
  /** The words the prose wrote after `hercule`. */
  readonly words: ReadonlyArray<string>;
  /**
   * The longest leading run of those words the tree answers to, or `undefined`
   * when it answers to none of them - or when the prose ran on past a run that
   * is a noun rather than a whole command, which reads as a misspelling.
   */
  readonly names: string | undefined;
  /** The command that run spells; absent when the run is only a noun. */
  readonly command: Command | undefined;
}

/**
 * Every `hercule ...` a piece of prose names. One scanner, so what the help
 * offers as the next command and what the table's test accepts are the same
 * reading.
 *
 * A flag, a `<placeholder>` or any other punctuation ends the mention, and
 * prose that runs on after a whole command - "hercule task list to find work" -
 * keeps the command.
 */
export const mentionsIn = (text: string): ReadonlyArray<Mention> =>
  [...text.matchAll(/\bhercule((?:\s+[a-z][a-z-]*)+)/g)].map((match) => {
    const words = match[1]!.trim().split(/\s+/);
    for (let length = words.length; length > 0; length -= 1) {
      const run = words.slice(0, length);
      const named = run.join(" ");
      const command = commandAt(run);
      const whole = command !== undefined || HAND_WRITTEN.includes(named);
      if (!whole && wordsAfter(run).length === 0) continue;
      if (length === words.length || whole) return { words, names: named, command };
      break;
    }
    return { words, names: undefined, command: undefined };
  });
