/**
 * A workflow's YAML text: the one parse of a text into a definition, and the
 * one canonical text of a definition object. The controller and the browser
 * both call them, so two programs can never disagree about what a text means
 * or about how an object is written as text.
 *
 * They sit apart from the definition's shape in `./workflow-definition`,
 * because they need the YAML library and the shape does not. The web app's first paint
 * loads the shapes of the whole API, and the YAML library loads only with the
 * pages that edit a workflow.
 */
import { Result, Schema } from "effect";
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  Scalar,
  stringify,
  type Document,
  type YAMLError,
} from "yaml";
import type { Issue } from "../errors";
import { excerptMessage } from "../excerpts";
import { decodeWorkflowDefinition, limitIssues, WorkflowDefinition } from "./workflow-definition";

/**
 * The longest text of a workflow the API stores, in characters, whether the
 * caller sent the text or a definition object that was written as text. The
 * prompts of several agent steps fit in it many times over.
 */
const MAX_WORKFLOW_SOURCE_LENGTH = 256 * 1024;

/**
 * A problem of a workflow's text, with what an editor needs to mark its place.
 * The public API sends only the path and the message, because the API names
 * a problem by its path and never by a position in a text.
 */
interface WorkflowSourceIssue extends Issue {
  /**
   * The place of a problem of the YAML itself, as offsets into the text: the
   * first character of the problem, and the character after its last. Such a
   * problem has an empty path, because the text did not become a definition,
   * and its message gives the line and the column.
   */
  readonly range?: readonly [from: number, to: number];
}

/** A problem as the public API names it: by its path and its message only. */
const buildPublicIssue = ({ path, message }: Issue): Issue => ({ path, message });

/**
 * Half of a UTF-16 surrogate pair with no other half beside it. It is not a
 * character, and the database cannot store it: it joins it to the next code
 * unit, so the stored text would say something the sent text does not.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const LONE_SURROGATE_MESSAGE =
  "contains half of a UTF-16 surrogate pair, which is not a character. Remove it, or write the whole character.";

/**
 * The line and the column of an offset into a text, both counted from 1. The
 * column counts characters, as the messages about templates do. A character
 * such as an emoji is two UTF-16 code units of the text, and one column.
 */
const findLineAndColumn = (
  text: string,
  lines: LineCounter,
  offset: number,
): { readonly line: number; readonly column: number } => {
  const { line, col } = lines.linePos(offset);
  return { line, column: [...text.slice(offset - col + 1, offset)].length + 1 };
};

/**
 * A YAML syntax error as an issue. The path is empty because the text did not
 * become a definition, so the place is given in the text, by line and column.
 */
const describeSyntaxError = (
  text: string,
  error: YAMLError,
  lines: LineCounter,
): WorkflowSourceIssue => {
  const { line, column } = findLineAndColumn(text, lines, error.pos[0]);
  return {
    path: [],
    message:
      `The YAML is not valid at line ${String(line)}, column ${String(column)}. ` +
      `The parser says: ${excerptMessage(error.message)} Correct the text at this position.`,
    range: error.pos,
  };
};

/**
 * The `%` that starts a YAML directive: the first character of a line, or the
 * first character after a leading byte order mark.
 */
const DIRECTIVE_START = /(?<=^\uFEFF?|\n)%/g;

/**
 * Each YAML directive of a text, as an issue at its line and column. A
 * directive changes how the rest of the text is read: under `%YAML 1.1`, `yes`
 * is a boolean and a date is a time in the local zone, so one text could say
 * two things. A directive can stand only before the
 * document starts, and the parser keeps no place for it, so the directives are
 * found in the text before the document's first character.
 */
const listDirectiveIssues = (
  text: string,
  documentStart: number,
  lines: LineCounter,
): ReadonlyArray<WorkflowSourceIssue> =>
  [...text.slice(0, documentStart).matchAll(DIRECTIVE_START)].map((directive) => {
    const { line, column } = findLineAndColumn(text, lines, directive.index);
    const lineEnd = text.indexOf("\n", directive.index);
    return {
      path: [],
      message:
        `The text at line ${String(line)}, column ${String(column)} is a YAML directive. ` +
        "A workflow does not use directives, because a directive changes how the rest of the text is read. Remove the line.",
      range: [directive.index, lineEnd === -1 ? text.length : lineEnd],
    };
  });

/** Why a workflow's text may not use anchors or aliases. */
const NO_ANCHORS =
  "A workflow does not use YAML anchors or aliases. " +
  "Write the value out in full at each place that needs it.";

/** Why a workflow's text may not use tags. */
const NO_TAGS =
  "A workflow does not use YAML tags, because a tag can make a value other than what the text shows. " +
  "Remove the tag, and write the value in quotes where it must be read as text.";

/** Why a key may not be a mapping or a list. */
const NO_COLLECTION_KEYS =
  "A key in this mapping is a mapping or a list. Write each key as one plain value.";

const REPEATED_KEY =
  "A key before this one in the same mapping reads as the same key. " +
  "Remove one of the two, or give each its own name.";

/**
 * A key of a YAML mapping as the parsed value spells it, and so as a path
 * into the definition spells it: the value of a scalar as text, so `1` and
 * `"1"` are one key, and an empty key as "". The core schema, with no tag
 * resolved, reads a scalar as a string, a number, a boolean or null. An alias
 * as a key is spelled "" too, and the walk refuses the alias where it meets
 * it. An editor spells keys the same way to find the node that a path names.
 */
export const spellPathKey = (key: unknown): string => {
  const value: unknown = isScalar(key) ? key.value : null;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
};

/**
 * Adds to `issues` each problem of a parsed node, and of the nodes inside it,
 * that the definition cannot see once the text becomes a value. Anchors and
 * aliases copy one part of the text into other places. A tag can make a value
 * other than what the text shows. A key that the value spells as an earlier
 * key of its mapping would silently replace that key's value, and a key that
 * is a mapping or a list has no single spelling. A half surrogate pair can be
 * written as an escape in a quoted scalar. Each problem is named at its place
 * in the definition, with each key spelled as the value spells it, so the
 * editor finds the place from the path.
 *
 * The walk makes one call for each level of the text. The parser that made
 * the nodes made several calls for each level, and it refuses a text nested
 * too deep for it, so the walk cannot exhaust the call stack.
 */
const collectNodeIssues = (
  node: unknown,
  path: ReadonlyArray<string>,
  issues: Array<WorkflowSourceIssue>,
): void => {
  if (isAlias(node) || (isNode(node) && node.anchor !== undefined)) {
    issues.push({ path, message: NO_ANCHORS });
    return;
  }
  if (isNode(node) && node.tag !== undefined) {
    issues.push({ path, message: NO_TAGS });
    return;
  }
  if (isScalar(node) && typeof node.value === "string" && LONE_SURROGATE.test(node.value)) {
    issues.push({ path, message: `This value ${LONE_SURROGATE_MESSAGE}` });
  }
  if (isMap(node)) {
    // One set for each mapping, so the check is linear in the number of keys.
    const keys = new Set<string>();
    for (const pair of node.items) {
      if (isMap(pair.key) || isSeq(pair.key)) {
        issues.push({ path, message: NO_COLLECTION_KEYS });
        continue;
      }
      const key = spellPathKey(pair.key);
      const keyPath = [...path, key];
      if (keys.has(key)) issues.push({ path: keyPath, message: REPEATED_KEY });
      keys.add(key);
      collectNodeIssues(pair.key, keyPath, issues);
      collectNodeIssues(pair.value, keyPath, issues);
    }
  }
  if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      collectNodeIssues(item, [...path, String(index)], issues);
    }
  }
};

/**
 * What one parse of a workflow's text found: the YAML document, and the
 * definition that the text says or the problems that stop the text from being
 * one.
 */
interface ParsedWorkflowDocument {
  /**
   * The YAML document, with the range in the text of each node. An editor
   * reads it to find the place in the text of a problem that is named by its
   * path, and to find what the author writes at the cursor. It is absent for a
   * text too long to parse.
   */
  readonly document: Document.Parsed | undefined;
  /** Where each line of the text starts, which gives the line of an offset. Absent with `document`. */
  readonly lines: LineCounter | undefined;
  /**
   * The definition, or the problems that stop the text from being one: at
   * most `MAX_ISSUES` problems, and one more problem that counts the others.
   */
  readonly result: Result.Result<WorkflowDefinition, ReadonlyArray<WorkflowSourceIssue>>;
}

/** Why a text is refused before it is parsed. */
const TOO_LONG_ISSUE: WorkflowSourceIssue = {
  path: [],
  // Said of the workflow and not of a text, because a definition object is
  // measured by the text it is written as.
  message: `A workflow is at most ${String(MAX_WORKFLOW_SOURCE_LENGTH)} characters of YAML. This one is longer. Make it shorter.`,
};

/**
 * The definition a workflow's text says, or the problems that stop the text
 * from being one: a text that is too long or not valid Unicode, YAML syntax,
 * directives, tags, anchors and aliases, repeated keys, and everything
 * `decodeWorkflowDefinition` refuses. The YAML document of the text comes
 * with the answer, so a program that must also find places in the text parses
 * the text once. The text itself is never changed.
 */
export const parseWorkflowDocument = (text: string): ParsedWorkflowDocument => {
  if (text.length > MAX_WORKFLOW_SOURCE_LENGTH) {
    return { document: undefined, lines: undefined, result: Result.fail([TOO_LONG_ISSUE]) };
  }
  const lines = new LineCounter();
  const document = parseDocument(text, {
    lineCounter: lines,
    prettyErrors: false,
    // The parser's own check of repeated keys compares each key with every
    // earlier key of its mapping, which takes quadratic time, and it misses
    // two keys that the value spells alike, such as `1` and `"1"`. The walk
    // checks the keys instead.
    uniqueKeys: false,
    // `<<` is an ordinary key, as YAML 1.2 reads it.
    merge: false,
    // A tag such as `!!binary` is not decoded. The walk refuses each tag.
    resolveKnownTags: false,
  });
  const refuse = (issues: ReadonlyArray<WorkflowSourceIssue>): ParsedWorkflowDocument => ({
    document,
    lines,
    result: Result.fail(limitIssues(issues)),
  });
  const surrogate = text.search(LONE_SURROGATE);
  if (surrogate !== -1) {
    const { line, column } = findLineAndColumn(text, lines, surrogate);
    return refuse([
      {
        path: [],
        message: `The text at line ${String(line)}, column ${String(column)} ${LONE_SURROGATE_MESSAGE}`,
        range: [surrogate, surrogate + 1],
      },
    ]);
  }
  if (document.errors.length > 0) {
    return refuse(document.errors.map((error) => describeSyntaxError(text, error, lines)));
  }
  const issues: Array<WorkflowSourceIssue> = [
    ...listDirectiveIssues(text, document.range[0], lines),
  ];
  collectNodeIssues(document.contents, [], issues);
  if (issues.length > 0) return refuse(issues);
  return { document, lines, result: decodeWorkflowDefinition(document.toJS()) };
};

/**
 * The definition a workflow's text says, or the problems that stop the text
 * from being one, as `parseWorkflowDocument` finds them. Each problem is named
 * by its path and its message, as the public API names it.
 */
export const parseWorkflowSource = (
  text: string,
): Result.Result<WorkflowDefinition, ReadonlyArray<Issue>> =>
  Result.mapError(parseWorkflowDocument(text).result, (issues) => issues.map(buildPublicIssue));

/**
 * Puts the keys of every object in the order the definition declares them.
 * Marked pure, so that a bundle that never renders a text, as the web app's,
 * leaves it out.
 */
const orderDefinitionKeys = /* @__PURE__ */ Schema.encodeSync(WorkflowDefinition);

/**
 * A string that only holds spaces, tabs and at least one line break. A block
 * scalar reads its first lines of such whitespace as indentation, so such a
 * string does not come back from a block as it went in, and it is
 * double-quoted. Only the whitespace of YAML itself counts: a no-break space
 * is text to YAML, and a block holds it. The YAML writer double-quotes a
 * string with a carriage return itself.
 */
const isBlankLines = (text: string): boolean => text.includes("\n") && /^[ \t\n]*$/.test(text);

/** The same value, with each string that needs double quotes marked for them. */
const markDoubleQuotes = (value: unknown): unknown => {
  if (typeof value === "string" && isBlankLines(value)) {
    const scalar = new Scalar(value);
    scalar.type = Scalar.QUOTE_DOUBLE;
    return scalar;
  }
  if (Array.isArray(value)) return value.map(markDoubleQuotes);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, markDoubleQuotes(item)]),
    );
  }
  return value;
};

/**
 * The canonical text of a definition object. The same object always gives the
 * same bytes. The keys that the definition declares follow the definition's
 * order, whatever order they were sent in. The keys that the author chooses,
 * in `params`, `options`, `outputSchema`, an input's `schema` and `default`,
 * and a trigger's `inputs` and `outputs`, keep the order in which they were
 * sent, because the definition gives them no order. A string with a newline
 * is a `|` block, a string that needs quotes has double quotes, and each level
 * is indented by two spaces. No line is folded, because a folded line is a
 * second way to write one string. A string of whitespace and line breaks
 * only, and a string with a control character, cannot be held by a block, and
 * is double-quoted.
 */
export const renderWorkflowSource = (definition: WorkflowDefinition): string =>
  stringify(markDoubleQuotes(orderDefinitionKeys(definition)), {
    indent: 2,
    singleQuote: false,
    lineWidth: 0,
  });
