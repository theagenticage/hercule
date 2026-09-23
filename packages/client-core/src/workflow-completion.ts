/**
 * What the editor offers to write at the cursor in a workflow's source. The
 * keys and the fixed values come from the definition's schema in the
 * contract, so the offers follow the shape that a save validates. The ids
 * that a step and a trigger name come from what the controller knows: its
 * action catalog, its agents and its event kinds.
 *
 * The mapping that the cursor writes into is found in the YAML document of the
 * one parse of the source, and the lines are the lines that the parse counted.
 * The line up to the cursor is read as text, because a key that the author has
 * half written is not a key in the document yet.
 */
import { SchemaAST } from "effect";
import { isMap, isNode, isScalar, isSeq, type LineCounter, type YAMLMap } from "yaml";
import {
  readFieldNotation,
  spellPathKey,
  WorkflowDefinition,
  type Agent,
  type DeclaredEventKind,
  type FieldNotation,
  type WorkflowAction,
} from "@hercule/contract";
import { idTail } from "./id-tail";
import { findLineEnd, findLineStart, type WorkflowSourceReading } from "./workflow-source";

/** What a workflow's source can name that the controller knows. */
export interface WorkflowCatalog {
  readonly actions: ReadonlyArray<Pick<WorkflowAction, "id" | "displayName" | "description">>;
  readonly agents: ReadonlyArray<Pick<Agent, "id" | "name">>;
  readonly eventKinds: ReadonlyArray<DeclaredEventKind>;
}

/** An offer to write text at the cursor. */
export interface CompletionOffer {
  /** What the list shows, and what the text that the author typed is matched against. */
  readonly label: string;
  /** A short note beside the label, such as the name of an action. */
  readonly detail?: string;
  /** What accepting the offer writes, in place of what the author typed of it. A line break in it is `\n`. */
  readonly text: string;
  /** Where the cursor goes after the offer is accepted, as an offset into `text`. Absent is the end. */
  readonly cursor?: number;
}

/** The offers at the cursor, and the offset where the text that they replace starts. */
export interface CompletionList {
  readonly from: number;
  readonly offers: ReadonlyArray<CompletionOffer>;
}

/** How many spaces one level of a block is indented by, as in the canonical text. */
const INDENT = 2;

/** The line up to the cursor, where it writes a value after a key: `key: val`, maybe after `- `. */
const VALUE_BEFORE_CURSOR = /^( *)((?:- +)?)(\w+): +([^\s#]*)$/;

/** The line up to the cursor, where it writes a key or nothing yet: `ke`, maybe after `- `. */
const KEY_BEFORE_CURSOR = /^( *)((?:- +)?)(\w*)$/;

/** What the line of the cursor writes, as far as the cursor. */
interface CursorLine {
  /** The offset of the first character of the line. */
  readonly start: number;
  /** The offset of the line break that ends the line, or of the end of the source. */
  readonly end: number;
  /** The column of the `- ` that starts a list item on the line, if the line has one. */
  readonly itemColumn: number | undefined;
  /** The column of the key that the line writes. */
  readonly keyColumn: number;
  /** The key before the cursor's value, or absent where the cursor writes a key. */
  readonly key: string | undefined;
  /** What the author typed of the key or of the value, before the cursor. */
  readonly typed: string;
}

/** A parsed source and the lines that the parse counted in it. */
interface CursorSource {
  readonly source: string;
  readonly lines: LineCounter;
}

/**
 * What the cursor's line writes up to the cursor, or `undefined` for a line
 * that writes neither a key nor a value after a key there.
 */
const readCursorLine = (
  source: string,
  lines: LineCounter,
  position: number,
): CursorLine | undefined => {
  const start = findLineStart(lines, position);
  const before = source.slice(start, position);
  const value = VALUE_BEFORE_CURSOR.exec(before);
  const match = value ?? KEY_BEFORE_CURSOR.exec(before);
  if (match === null) return undefined;
  const [, indent = "", item = ""] = match;
  return {
    start,
    end: findLineEnd(source, lines, position),
    itemColumn: item === "" ? undefined : indent.length,
    keyColumn: indent.length + item.length,
    key: value?.[3],
    typed: (value === null ? match[3] : value[4]) ?? "",
  };
};

/** The offset where a node of the document starts, if it is a node. */
const readNodeStart = (node: unknown): number | undefined =>
  isNode(node) ? node.range?.[0] : undefined;

/** The column of an offset in its line, counted from 0. */
const findColumn = (lines: LineCounter, offset: number): number => lines.linePos(offset).col - 1;

/**
 * The path of the mapping that the cursor's line writes a key of, and the
 * node of the document at each step of the path, the last one that mapping.
 * The last node is not a mapping where the line starts the mapping: a key
 * written with nothing after it, or a list item with nothing in it yet.
 *
 * The walk goes down by indentation, because the line may be half written:
 * at each mapping it takes the last key before the line, and at each list the
 * last item before the line, until it meets the mapping whose keys stand in
 * the column of the line's key.
 */
const findCursorMapping = (
  lines: LineCounter,
  contents: unknown,
  line: CursorLine,
): { readonly path: ReadonlyArray<string>; readonly nodes: ReadonlyArray<unknown> } | undefined => {
  const path: Array<string> = [];
  const nodes: Array<unknown> = [];
  let node = contents;
  for (;;) {
    nodes.push(node);
    if (isMap(node)) {
      const column = findColumn(lines, readNodeStart(node) ?? 0);
      if (line.keyColumn === column) return { path, nodes };
      if (line.keyColumn < column) return undefined;
      const pair = node.items.findLast(
        (item) => (readNodeStart(item.key) ?? Infinity) < line.start,
      );
      if (pair === undefined) return undefined;
      path.push(spellPathKey(pair.key));
      node = pair.value;
    } else if (isSeq(node)) {
      const column = findColumn(lines, readNodeStart(node) ?? 0);
      if (line.itemColumn === column) {
        // The line starts an item of this list.
        const index = node.items.findIndex((item) => (readNodeStart(item) ?? -1) >= line.start);
        path.push(String(index === -1 ? node.items.length : index));
        node = node.items[index] ?? null;
        continue;
      }
      if (line.keyColumn <= column) return undefined;
      const index = node.items.findLastIndex(
        (item) => (readNodeStart(item) ?? Infinity) < line.start,
      );
      if (index === -1) return undefined;
      path.push(String(index));
      node = node.items[index];
    } else {
      // A value written as nothing, or a word that the line starts: the line
      // starts the mapping. A value written before the line holds no keys.
      const start = readNodeStart(node);
      const isStarting =
        node === null ||
        node === undefined ||
        (isScalar(node) && (node.value === null || (start !== undefined && start >= line.start)));
      return isStarting ? { path, nodes } : undefined;
    }
  }
};

/** Each member of a union, and each member of the unions inside it. */
const flattenUnion = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  SchemaAST.isUnion(ast) ? ast.types.flatMap(flattenUnion) : [ast];

/** The `kind` that an object shape declares as a literal, if it declares one. */
const readShapeKind = (shape: SchemaAST.Objects): string | undefined => {
  const kind = shape.propertySignatures.find((property) => property.name === "kind")?.type;
  return kind !== undefined && SchemaAST.isLiteral(kind) ? String(kind.literal) : undefined;
};

/**
 * The object shapes among some types, narrowed to the members of a union
 * whose kind the mapping writes. A mapping that writes no kind, or a kind that
 * no member has, may have the shape of any member.
 */
const narrowShapes = (
  types: ReadonlyArray<SchemaAST.AST>,
  kind: string | undefined,
): ReadonlyArray<SchemaAST.Objects> => {
  const shapes = types.flatMap(flattenUnion).filter(SchemaAST.isObjects);
  const written = shapes.filter((shape) => readShapeKind(shape) === kind);
  return kind !== undefined && written.length > 0 ? written : shapes;
};

/** The types that a key's value may have in some object shapes. */
const readValueTypes = (
  shapes: ReadonlyArray<SchemaAST.Objects>,
  key: string,
): ReadonlyArray<SchemaAST.AST> =>
  shapes.flatMap((shape) => {
    const property = shape.propertySignatures.find((signature) => signature.name === key);
    return property === undefined
      ? shape.indexSignatures.map((signature) => signature.type)
      : [property.type];
  });

/** The fixed values that a type allows: its literals, and `true` and `false` for a boolean. */
const listFixedValues = (ast: SchemaAST.AST): ReadonlyArray<string> =>
  flattenUnion(ast).flatMap((member) =>
    SchemaAST.isLiteral(member)
      ? [String(member.literal)]
      : SchemaAST.isBoolean(member)
        ? ["true", "false"]
        : [],
  );

/**
 * The offer to write a key, and the start of its value in the form that YAML
 * keeps as written. A template is text for an agent, usually on several
 * lines, which a `|` block holds as written. An expression or a schedule often
 * holds characters that YAML reads as its own, and a value in double quotes
 * is read as text.
 */
const buildKeyOffer = (
  key: string,
  notation: FieldNotation | undefined,
  keyColumn: number,
): CompletionOffer => {
  if (notation === "template") {
    return { label: key, text: `${key}: |\n${" ".repeat(keyColumn + INDENT)}` };
  }
  if (notation !== undefined) {
    const text = `${key}: ""`;
    return { label: key, text, cursor: text.length - 1 };
  }
  return { label: key, text: `${key}: ` };
};

/** The values from what the controller knows that a key names, where it names one. */
const listCatalogValues = (
  path: ReadonlyArray<string>,
  key: string,
  catalog: WorkflowCatalog,
): ReadonlyArray<CompletionOffer> | undefined => {
  const [list, , field] = path;
  if (path.length === 2 && list === "steps" && key === "action") {
    return catalog.actions.map((action) => ({
      label: action.id,
      detail: action.displayName,
      text: action.id,
    }));
  }
  if (path.length === 2 && list === "steps" && key === "agent") {
    // Two agents may have one name. The offer of each then shows the tail of
    // its id beside the name, so that the author can tell the two apart.
    const names = catalog.agents.map((agent) => agent.name);
    return catalog.agents.map((agent) => ({
      label: agent.name,
      ...(names.indexOf(agent.name) === names.lastIndexOf(agent.name)
        ? {}
        : { detail: idTail(agent.id) }),
      text: agent.id,
    }));
  }
  if (path.length === 3 && list === "triggers" && field === "source" && key === "kind") {
    return catalog.eventKinds.map((eventKind) => ({
      label: eventKind.kind,
      detail: eventKind.description,
      text: eventKind.kind,
    }));
  }
  return undefined;
};

/**
 * The key of a pair as it stands in the source, or `undefined` for the key
 * that the cursor's line writes, which is still being typed. The parser reads
 * a word that the author has started on the line above a key as the first
 * word of that key, as in `pr kind: agent`. The key on the later line is
 * written, so it is the last line of such a key's text.
 */
const readWrittenKey = (
  { source, lines }: CursorSource,
  key: unknown,
  line: CursorLine,
): string | undefined => {
  const range = isNode(key) ? key.range : undefined;
  if (range === undefined || range === null || range[0] < line.start || range[0] > line.end) {
    return spellPathKey(key);
  }
  if (range[1] <= line.end) return undefined;
  return source.slice(findLineStart(lines, range[1] - 1), range[1]).trim();
};

/** The pairs of a mapping that the source has written, each with its key as written. */
const listWrittenPairs = (
  cursorSource: CursorSource,
  mapping: YAMLMap,
  line: CursorLine,
): ReadonlyArray<{ readonly key: string; readonly value: unknown }> =>
  mapping.items.flatMap((pair) => {
    const key = readWrittenKey(cursorSource, pair.key, line);
    return key === undefined ? [] : [{ key, value: pair.value }];
  });

/**
 * What to offer at an offset of a workflow's source: after `key: `, the
 * values that the key takes, and where the line writes a key, each key of the
 * mapping that the mapping does not have yet, above or below the line. A key
 * or a value that the cursor's line writes is being typed, so it does not
 * count as written.
 */
export const listWorkflowCompletions = (
  reading: WorkflowSourceReading,
  position: number,
  catalog: WorkflowCatalog,
): CompletionList | undefined => {
  const { source, document, lines } = reading;
  if (document === undefined || lines === undefined) return undefined;
  const line = readCursorLine(source, lines, position);
  if (line === undefined) return undefined;
  const place = findCursorMapping(lines, document.contents, line);
  if (place === undefined) return undefined;
  const cursorSource: CursorSource = { source, lines };

  const readKind = (node: unknown): string | undefined => {
    if (!isMap(node)) return undefined;
    const kind = listWrittenPairs(cursorSource, node, line).findLast(
      (pair) => pair.key === "kind",
    )?.value;
    return isScalar(kind) ? String(kind.value) : undefined;
  };
  let types: ReadonlyArray<SchemaAST.AST> = [WorkflowDefinition.ast];
  for (const [depth, segment] of place.path.entries()) {
    const arrays = types.flatMap(flattenUnion).filter(SchemaAST.isArrays);
    types = [
      ...readValueTypes(narrowShapes(types, readKind(place.nodes[depth])), segment),
      ...arrays.flatMap((array) => array.rest),
    ];
  }
  const mapping = place.nodes.at(-1);
  const shapes = narrowShapes(types, readKind(mapping));
  const buildCompletionList = (
    offers: ReadonlyArray<CompletionOffer>,
  ): CompletionList | undefined =>
    offers.length === 0 ? undefined : { from: position - line.typed.length, offers };

  if (line.key !== undefined) {
    return buildCompletionList(
      listCatalogValues(place.path, line.key, catalog) ??
        [...new Set(readValueTypes(shapes, line.key).flatMap(listFixedValues))].map((value) => ({
          label: value,
          text: value,
        })),
    );
  }
  const written = new Set(
    isMap(mapping) ? listWrittenPairs(cursorSource, mapping, line).map((pair) => pair.key) : [],
  );
  // Each key once, in the order of the schema, with the notation of its value.
  const keys = new Map<string, FieldNotation | undefined>();
  for (const { name, type } of shapes.flatMap((shape) => shape.propertySignatures)) {
    if (!keys.has(String(name))) keys.set(String(name), readFieldNotation(type));
  }
  return buildCompletionList(
    [...keys]
      .filter(([key]) => !written.has(key))
      .map(([key, notation]) => buildKeyOffer(key, notation, line.keyColumn)),
  );
};
