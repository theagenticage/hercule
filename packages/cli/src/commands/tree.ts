/**
 * The command tree, derived from the contract.
 *
 * `hydra <entity> <verb>` is the operation id `<entity>.<verb>`, spelled exactly
 * as the contract spells it (spec 11 section 6.3). Nothing here is a list of
 * commands: the entities, the verbs, the positional arguments and the flags are
 * all read out of the `HttpApi` declaration, so an operation added to the
 * contract appears in the CLI, in `--help` and in the tests with no edit.
 *
 * The AST walk is deliberately shallow. A field is one of five shapes - string,
 * number, boolean, a list of one of those, or anything else, which arrives as
 * JSON - and that is enough for every operation in the API. A deeper mapping
 * would be a schema-to-flags compiler nobody asked for.
 */
import { OPERATIONS, api, type Method, type OperationId, type Requirement } from "@hydra/contract";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";

/** How a flag's or positional's text becomes a value. */
export type FieldKind = "string" | "number" | "boolean" | "json";

export interface Field {
  readonly name: string;
  readonly kind: FieldKind;
  /** The flag may be given more than once; the values become a list. */
  readonly repeated: boolean;
  readonly optional: boolean;
  /** The closed set of accepted values, when the schema declares one. */
  readonly choices: ReadonlyArray<string> | undefined;
}

export interface Command {
  readonly id: OperationId;
  readonly entity: string;
  readonly verb: string;
  readonly requires: Requirement;
  readonly method: Method;
  readonly path: string;
  /** Path parameters, in route order; given positionally. */
  readonly positionals: ReadonlyArray<Field>;
  /** Payload fields; given as `--<field>`. */
  readonly payload: ReadonlyArray<Field>;
  /** Query fields other than the pagination triple; given as `--<field>`. */
  readonly query: ReadonlyArray<Field>;
  /** The operation pages: `--limit`, `--cursor`, `--sort`, `--all` apply. */
  readonly paged: boolean;
  /** The fields `--sort` accepts, when the operation pages. */
  readonly sortFields: ReadonlyArray<string>;
}

/** The pagination triple every `query` operation carries; handled by name, not as flags. */
const PAGE_FIELDS = new Set(["limit", "cursor", "sort"]);

type Ast = {
  readonly _tag: string;
  readonly types?: ReadonlyArray<Ast>;
  readonly rest?: ReadonlyArray<Ast>;
  readonly literal?: unknown;
  readonly context?: { readonly isOptional?: boolean };
  readonly propertySignatures?: ReadonlyArray<{ readonly name: PropertyKey; readonly type: Ast }>;
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

const scalarKind = (ast: Ast): FieldKind => {
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

const fieldOf = (name: string, ast: Ast): Field => {
  const optional = ast.context?.isOptional === true;
  const element = ast._tag === "Arrays" ? ast.rest?.[0] : undefined;
  if (element !== undefined) {
    return {
      name,
      kind: scalarKind(element),
      repeated: true,
      optional,
      choices: literalsOf(element),
    };
  }
  return { name, kind: scalarKind(ast), repeated: false, optional, choices: literalsOf(ast) };
};

const fieldsOf = (schema: unknown): ReadonlyArray<Field> => {
  const ast = (schema as { ast?: Ast } | undefined)?.ast;
  if (ast?.propertySignatures === undefined) return [];
  return ast.propertySignatures.map((property) => fieldOf(String(property.name), property.type));
};

/** The payload schema hides one level deeper: a media-type map holding a codec. */
const payloadFieldsOf = (payload: unknown): ReadonlyArray<Field> => {
  if (!(payload instanceof Map)) return [];
  const json = payload.get("application/json") as { schemas?: ReadonlyArray<unknown> } | undefined;
  const codec = json?.schemas?.[0] as { schema?: unknown } | undefined;
  return fieldsOf(codec?.schema);
};

/** `:name` path parameters, in the order the route writes them. */
const pathParams = (path: string): ReadonlyArray<string> =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);

const build = (): ReadonlyArray<Command> => {
  const commands: Array<Command> = [];

  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group }) => {
      const id = `${group.identifier}.${endpoint.identifier}` as OperationId;
      const row = OPERATIONS[id];
      const params = new Map(
        fieldsOf((endpoint as { params?: unknown }).params).map((field) => [field.name, field]),
      );
      const query = fieldsOf((endpoint as { query?: unknown }).query);
      const sort = query.find((field) => field.name === "sort");

      commands.push({
        id,
        entity: group.identifier,
        verb: endpoint.identifier,
        requires: row.requires,
        method: row.method,
        path: row.path,
        positionals: pathParams(row.path).map(
          (name) =>
            params.get(name) ?? {
              name,
              kind: "string",
              repeated: false,
              optional: false,
              choices: undefined,
            },
        ),
        payload: payloadFieldsOf((endpoint as { payload?: unknown }).payload),
        query: query.filter((field) => !PAGE_FIELDS.has(field.name)),
        paged: sort !== undefined,
        sortFields: sortFieldsOf((endpoint as { query?: unknown }).query),
      });
    },
  });

  return commands;
};

/** The literals `sort.field` accepts, read from the operation's own sort schema. */
const sortFieldsOf = (query: unknown): ReadonlyArray<string> => {
  const ast = (query as { ast?: Ast } | undefined)?.ast;
  const sort = ast?.propertySignatures?.find((property) => String(property.name) === "sort")?.type;
  const field = sort?.propertySignatures?.find((property) => String(property.name) === "field");
  return field === undefined ? [] : (literalsOf(field.type) ?? []);
};

/** Every command, in the contract's own order. */
export const COMMANDS: ReadonlyArray<Command> = build();

/** Every entity, in the contract's own order. */
export const ENTITIES: ReadonlyArray<string> = [...new Set(COMMANDS.map((c) => c.entity))];

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

export const commandFor = (entity: string, verb: string): Command | undefined =>
  BY_ID.get(`${entity}.${verb}` as OperationId);

export const verbsOf = (entity: string): ReadonlyArray<Command> =>
  COMMANDS.filter((command) => command.entity === entity);

/** The `query` command of an entity, which is what resolves an id tail. */
export const queryCommandOf = (entity: string): Command | undefined => commandFor(entity, "query");
