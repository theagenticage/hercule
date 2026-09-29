/**
 * Autocompletion for a workflow's YAML source.
 *
 * - Keys and fixed values (literals, booleans) come from the workflow schema
 *   in the contract, so the suggestions match what a save validates.
 * - Action ids, agent ids and event kinds come from the controller's catalog.
 *
 * The mapping at the cursor is found in the parsed YAML document. The current
 * line up to the cursor is matched as plain text instead, because a key the
 * author is still typing is not yet a key in the document.
 */
import { SchemaAST } from "effect";
import { isMap, isNode, isScalar, isSeq, type LineCounter, type YAMLMap } from "yaml";
import {
  readFieldNotation,
  convertKeyToPathSegment,
  WorkflowDefinition,
  type Agent,
  type DeclaredEventKind,
  type FieldNotation,
  type WorkflowAction,
} from "@hercule/contract";
import { toIdTail } from "./id-tail";
import { findLineEnd, findLineStart, type ParsedWorkflowSource } from "./workflow-source";

/** The ids from the controller that a workflow can reference. */
export interface WorkflowCatalog {
  readonly actions: ReadonlyArray<Pick<WorkflowAction, "id" | "displayName" | "description">>;
  readonly agents: ReadonlyArray<Pick<Agent, "id" | "name">>;
  readonly eventKinds: ReadonlyArray<DeclaredEventKind>;
}

/** One completion suggestion. */
export interface CompletionOption {
  /** The text shown in the list. The author's typed text is matched against it. */
  readonly label: string;
  /** A short note shown beside the label, such as an action's display name. */
  readonly detail?: string;
  /** The text inserted when the option is picked. Line breaks are `\n`. */
  readonly text: string;
  /** The cursor position after insertion, as an offset into `text`. Defaults to the end. */
  readonly cursor?: number;
}

/**
 * The completion options at the cursor, and the range of text they replace.
 * A key option replaces only the part of the key before the cursor. A value
 * option replaces the whole value, including the part after the cursor, so no
 * part of the old value is left behind.
 */
export interface CompletionList {
  readonly from: number;
  readonly to: number;
  readonly options: ReadonlyArray<CompletionOption>;
}

/** The number of spaces per indent level, as in the canonical YAML. */
const INDENT = 2;

/** Matches a line, up to the cursor, that is typing a value: `key: val`, maybe after `- `. */
const VALUE_BEFORE_CURSOR = /^( *)((?:- +)?)(\w+): +([^\s#]*)$/;

/** Matches a line, up to the cursor, that is typing a key or is empty: `ke`, maybe after `- `. */
const KEY_BEFORE_CURSOR = /^( *)((?:- +)?)(\w*)$/;

/**
 * Matches the text after a value on its line: whitespace, optionally followed
 * by a comment. A `#` at the start of the value also starts a comment,
 * because a value always follows a space.
 */
const AFTER_VALUE = /(?:(?:^|\s+)#[^]*|\s*)$/;

/** The cursor's line, parsed up to the cursor. */
interface CursorLine {
  /** The offset of the line's first character. */
  readonly start: number;
  /** The offset of the `\n` that ends the line, or the source length on the last line. */
  readonly end: number;
  /** The column of the `- ` list item marker, if the line has one. */
  readonly itemColumn: number | undefined;
  /** The column of the line's key. */
  readonly keyColumn: number;
  /** The key when the cursor is in its value, or `undefined` when the cursor is in a key. */
  readonly key: string | undefined;
  /** The part of the key or value that the author typed before the cursor. */
  readonly typed: string;
}

/** A source and its line counter from the YAML parse. */
interface CursorSource {
  readonly source: string;
  readonly lines: LineCounter;
}

/**
 * Parses the cursor's line up to the cursor. Returns `undefined` when the
 * cursor is neither in a key nor in a value after a key.
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

/** Returns the start offset of a YAML node, or `undefined` if the value is not a node. */
const readNodeStart = (node: unknown): number | undefined =>
  isNode(node) ? node.range?.[0] : undefined;

/** Returns the 0-based column of an offset. */
const findColumn = (lines: LineCounter, offset: number): number => lines.linePos(offset).col - 1;

/**
 * Finds the mapping that the cursor's line adds a key to. Returns the path to
 * the mapping and the YAML node at each segment of that path. The last node
 * is the mapping itself. Returns `undefined` when no mapping fits.
 *
 * The last node is not a mapping when the cursor's line is the first key of a
 * new mapping, for example under a key with no value yet, or in an empty list
 * item.
 *
 * The search walks down by indentation, because the current line may be only
 * half typed. At each mapping it follows the last key above the line. At
 * each list it follows the last item above the line. It stops at the mapping
 * whose keys are in the same column as the line's key.
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
      path.push(convertKeyToPathSegment(pair.key));
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
      // An empty value, or a scalar that starts on the cursor's line: the line
      // is the first key of a new mapping. A scalar that starts on an earlier
      // line cannot hold keys.
      const start = readNodeStart(node);
      const isStarting =
        node === null ||
        node === undefined ||
        (isScalar(node) && (node.value === null || (start !== undefined && start >= line.start)));
      return isStarting ? { path, nodes } : undefined;
    }
  }
};

/** Returns the members of a union, flattening nested unions. A non-union returns itself. */
const flattenUnion = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  SchemaAST.isUnion(ast) ? ast.types.flatMap(flattenUnion) : [ast];

/** Returns the literal value of an object schema's `kind` field, if it has one. */
const readShapeKind = (shape: SchemaAST.Objects): string | undefined => {
  const kind = shape.propertySignatures.find((property) => property.name === "kind")?.type;
  return kind !== undefined && SchemaAST.isLiteral(kind) ? String(kind.literal) : undefined;
};

/** Returns whether an object schema accepts `key`: it declares the key, or accepts any key. */
const acceptsKey = (shape: SchemaAST.Objects, key: string): boolean =>
  shape.indexSignatures.length > 0 ||
  shape.propertySignatures.some((property) => property.name === key);

/**
 * Returns the object schemas among `types` that a mapping with the `written`
 * pairs can still become:
 *
 * - When the mapping has a `kind` that some schema has as its literal, only
 *   those schemas. A step's kind picks its shape this way.
 * - Of those, only the schemas that accept every written key. A start
 *   trigger's `on` has no literal to tell its shapes apart, so writing
 *   `kind` rules out the schedule, and writing `schedule` rules out the event
 *   selector.
 *
 * When a rule would leave no schema, it is skipped, because the mapping
 * already has an error and every schema is still a guess.
 */
const narrowShapes = (
  types: ReadonlyArray<SchemaAST.AST>,
  written: ReadonlyArray<WrittenPair>,
): ReadonlyArray<SchemaAST.Objects> => {
  const shapes = types.flatMap(flattenUnion).filter(SchemaAST.isObjects);
  const kindValue = written.findLast((pair) => pair.key === "kind")?.value;
  const kind = isScalar(kindValue) ? String(kindValue.value) : undefined;
  const ofKind = shapes.filter((shape) => readShapeKind(shape) === kind);
  const candidates = kind !== undefined && ofKind.length > 0 ? ofKind : shapes;
  const accepting = candidates.filter((shape) =>
    written.every((pair) => acceptsKey(shape, pair.key)),
  );
  return accepting.length > 0 ? accepting : candidates;
};

/** Returns the possible types of a key's value across some object schemas. */
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

/** Returns the fixed values a type allows: its literals, and `true` and `false` for a boolean. */
const listFixedValues = (ast: SchemaAST.AST): ReadonlyArray<string> =>
  flattenUnion(ast).flatMap((member) =>
    SchemaAST.isLiteral(member)
      ? [String(member.literal)]
      : SchemaAST.isBoolean(member)
        ? ["true", "false"]
        : [],
  );

/**
 * Builds the completion option for a key. The inserted text also starts the
 * value in a form that YAML reads literally:
 * - A template is usually multi-line text for an agent, so it gets a `|`
 *   block.
 * - An expression or a schedule often contains characters that are special
 *   in YAML, so it gets double quotes with the cursor between them.
 */
const buildKeyOption = (
  key: string,
  notation: FieldNotation | undefined,
  keyColumn: number,
): CompletionOption => {
  if (notation === "template") {
    return { label: key, text: `${key}: |\n${" ".repeat(keyColumn + INDENT)}` };
  }
  if (notation !== undefined) {
    const text = `${key}: ""`;
    return { label: key, text, cursor: text.length - 1 };
  }
  return { label: key, text: `${key}: ` };
};

/**
 * Returns the catalog ids that a key takes as its value, or `undefined` for a
 * key whose value is not a catalog id.
 */
const listCatalogValues = (
  path: ReadonlyArray<string>,
  key: string,
  catalog: WorkflowCatalog,
): ReadonlyArray<CompletionOption> | undefined => {
  const [list, , field] = path;
  if (path.length === 2 && list === "steps" && key === "action") {
    return catalog.actions.map((action) => ({
      label: action.id,
      detail: action.displayName,
      text: action.id,
    }));
  }
  if (path.length === 2 && list === "steps" && key === "agent") {
    // Two agents can have the same name. Those agents show the end of their
    // id beside the name, so the author can tell them apart.
    const names = catalog.agents.map((agent) => agent.name);
    return catalog.agents.map((agent) => ({
      label: agent.name,
      ...(names.indexOf(agent.name) === names.lastIndexOf(agent.name)
        ? {}
        : { detail: toIdTail(agent.id) }),
      text: agent.id,
    }));
  }
  if (path.length === 3 && list === "triggers" && field === "on" && key === "kind") {
    return catalog.eventKinds.map((eventKind) => ({
      label: eventKind.kind,
      detail: eventKind.description,
      text: eventKind.kind,
    }));
  }
  return undefined;
};

/**
 * Returns a pair's key as written in the source, or `undefined` for the key
 * on the cursor's line, which is still being typed.
 *
 * When the author starts a word on the line above an existing key, the parser
 * joins the two lines into one key, such as `pr kind`. The real key is on the
 * last of those lines.
 */
const readWrittenKey = (
  { source, lines }: CursorSource,
  key: unknown,
  line: CursorLine,
): string | undefined => {
  const range = isNode(key) ? key.range : undefined;
  if (range === undefined || range === null || range[0] < line.start || range[0] > line.end) {
    return convertKeyToPathSegment(key);
  }
  if (range[1] <= line.end) return undefined;
  return source.slice(findLineStart(lines, range[1] - 1), range[1]).trim();
};

/** A key of a mapping as written in the source, with its value node. */
interface WrittenPair {
  readonly key: string;
  readonly value: unknown;
}

/** Returns a mapping's pairs with their keys as written, leaving out the key being typed. */
const listWrittenPairs = (
  cursorSource: CursorSource,
  mapping: YAMLMap,
  line: CursorLine,
): ReadonlyArray<WrittenPair> =>
  mapping.items.flatMap((pair) => {
    const key = readWrittenKey(cursorSource, pair.key, line);
    return key === undefined ? [] : [{ key, value: pair.value }];
  });

/**
 * Returns the completion options at an offset in a workflow's source, or
 * `undefined` when there are none.
 *
 * - After `key: `, the values the key accepts.
 * - Where a key is being typed, each key the mapping does not have yet, on
 *   any line.
 *
 * The key or value on the cursor's line is still being typed, so it does not
 * count as already present.
 */
export const listWorkflowCompletions = (
  parsed: ParsedWorkflowSource,
  position: number,
  catalog: WorkflowCatalog,
): CompletionList | undefined => {
  const { source, document, lines } = parsed;
  if (document === undefined || lines === undefined) return undefined;
  const line = readCursorLine(source, lines, position);
  if (line === undefined) return undefined;
  const place = findCursorMapping(lines, document.contents, line);
  if (place === undefined) return undefined;
  const cursorSource: CursorSource = { source, lines };

  const listPairs = (node: unknown): ReadonlyArray<WrittenPair> =>
    isMap(node) ? listWrittenPairs(cursorSource, node, line) : [];
  let types: ReadonlyArray<SchemaAST.AST> = [WorkflowDefinition.ast];
  for (const [depth, segment] of place.path.entries()) {
    const arrays = types.flatMap(flattenUnion).filter(SchemaAST.isArrays);
    types = [
      ...readValueTypes(narrowShapes(types, listPairs(place.nodes[depth])), segment),
      ...arrays.flatMap((array) => array.rest),
    ];
  }
  const writtenPairs = listPairs(place.nodes.at(-1));
  const shapes = narrowShapes(types, writtenPairs);
  const from = position - line.typed.length;
  const buildCompletionList = (
    options: ReadonlyArray<CompletionOption>,
    to: number,
  ): CompletionList | undefined => (options.length === 0 ? undefined : { from, to, options });

  if (line.key !== undefined) {
    return buildCompletionList(
      listCatalogValues(place.path, line.key, catalog) ??
        [...new Set(readValueTypes(shapes, line.key).flatMap(listFixedValues))].map((value) => ({
          label: value,
          text: value,
        })),
      from + source.slice(from, line.end).search(AFTER_VALUE),
    );
  }
  const written = new Set(writtenPairs.map((pair) => pair.key));
  // Each key once, in schema order, with the notation of its value.
  const keys = new Map<string, FieldNotation | undefined>();
  for (const { name, type } of shapes.flatMap((shape) => shape.propertySignatures)) {
    if (!keys.has(String(name))) keys.set(String(name), readFieldNotation(type));
  }
  return buildCompletionList(
    [...keys]
      .filter(([key]) => !written.has(key))
      .map(([key, notation]) => buildKeyOption(key, notation, line.keyColumn)),
    position,
  );
};
