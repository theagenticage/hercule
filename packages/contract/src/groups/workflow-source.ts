/**
 * Parses workflow YAML into a definition (`parseWorkflowSource`) and converts
 * a definition object to canonical YAML (`renderWorkflowSource`). The
 * controller and the browser both call these functions, so they always agree
 * on what a source means and on how an object is written as YAML.
 *
 * These functions live apart from the schema in `./workflow-definition`,
 * because they need the YAML library and the schema does not. The web app's
 * initial bundle includes the schemas of the whole API, and the YAML library
 * loads only with the pages that edit a workflow.
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
import { shortenLibraryMessage } from "../excerpts";
import {
  decodeWorkflowDefinition,
  truncateIssues,
  WorkflowDefinition,
} from "./workflow-definition";

/**
 * The maximum length, in characters, of a workflow's YAML source that the API
 * stores. It applies whether the caller sent YAML or a definition object that
 * was converted to YAML. The prompts of several agent steps fit in it many
 * times over.
 */
const MAX_WORKFLOW_SOURCE_LENGTH = 256 * 1024;

/**
 * An issue in a workflow's source, with the extra information an editor needs
 * to highlight it. The public API sends only the path and the message, because
 * the API identifies an issue by its path, never by a position in the text.
 */
interface WorkflowSourceIssue extends Issue {
  /**
   * The position of an error in the YAML itself, as offsets into the source:
   * the first character of the error and the character after its last. Such
   * an issue has an empty path, because the source did not parse to a
   * definition, and its message gives the line and column.
   */
  readonly range?: readonly [from: number, to: number];
}

/** Returns only the path and message of an issue: the fields the public API sends. */
const buildPublicIssue = ({ path, message }: Issue): Issue => ({ path, message });

/**
 * A lone UTF-16 surrogate: half of a surrogate pair without its other half.
 * It is not a valid character, and the database cannot store it: the database
 * joins it to the next code unit, so the stored text would differ from the
 * text that was sent.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const LONE_SURROGATE_MESSAGE =
  "contains a lone UTF-16 surrogate, which is not a valid character. Remove it, or write the whole character.";

/**
 * Returns the line and column of an offset into the text, both counted from
 * 1. The column counts characters, as the template error messages do. An
 * emoji, for example, is two UTF-16 code units but one column.
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
 * Converts a YAML syntax error to an issue. The path is empty because the
 * source did not parse to a definition, so the message gives the line and
 * column instead.
 */
const buildSyntaxIssue = (
  text: string,
  error: YAMLError,
  lines: LineCounter,
): WorkflowSourceIssue => {
  const { line, column } = findLineAndColumn(text, lines, error.pos[0]);
  return {
    path: [],
    message:
      `The YAML is not valid at line ${String(line)}, column ${String(column)}. ` +
      `Parser error: ${shortenLibraryMessage(error.message)} Fix the source at this position.`,
    range: error.pos,
  };
};

/**
 * Matches the `%` that starts a YAML directive: at the start of a line, or
 * right after a leading byte order mark.
 */
const DIRECTIVE_START = /(?<=^\uFEFF?|\n)%/g;

/**
 * Returns an issue for each YAML directive in the text, with its line and
 * column. A directive changes how the rest of the text is parsed: under
 * `%YAML 1.1`, `yes` is a boolean and a date is a time in the local time zone,
 * so the same text could mean two things. A directive can only appear before
 * the document starts, and the parser does not record its position, so this
 * function searches the text before the document's first character.
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
        "Workflows cannot use directives, because a directive changes how the rest of the text is parsed. Remove the line.",
      range: [directive.index, lineEnd === -1 ? text.length : lineEnd],
    };
  });

/** The error message for a YAML anchor or alias. */
const NO_ANCHORS =
  "Workflows cannot use YAML anchors or aliases. " +
  "Write the value out in full everywhere it is needed.";

/** The error message for a YAML tag. */
const NO_TAGS =
  "Workflows cannot use YAML tags, because a tag can turn a value into something other than what the text shows. " +
  "Remove the tag, and put the value in quotes if it must be text.";

/** The error message for a mapping key that is itself a mapping or a list. */
const NO_COLLECTION_KEYS =
  "A key in this mapping is a mapping or a list. Use a plain value, such as a word, as each key.";

const REPEATED_KEY =
  "This key is the same as an earlier key in the same mapping. " + "Remove or rename one of them.";

/**
 * Converts a YAML mapping key to the string used for it in a definition path.
 * A scalar becomes its value as a string, so `1` and `"1"` are the same key,
 * and an empty key becomes "". Without tag resolution, the core schema parses
 * a scalar as a string, a number, a boolean or null. An alias used as a key
 * also becomes "", and `collectNodeIssues` rejects the alias itself. The
 * editor uses this function too, to find the node that a path refers to.
 */
export const convertKeyToPathSegment = (key: unknown): string => {
  const value: unknown = isScalar(key) ? key.value : null;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
};

/**
 * Adds to `issues` every problem in a parsed YAML node and its children that
 * would be lost once the YAML is converted to a plain value:
 *
 * - Anchors and aliases copy one part of the source into other places.
 * - A tag can turn a value into something other than what the text shows.
 * - A key equal to an earlier key of its mapping would silently replace that
 *   key's value.
 * - A key that is a mapping or a list has no string form for a path.
 * - A lone surrogate can be written as an escape in a quoted string.
 *
 * Each issue is reported at its path in the definition, with keys converted
 * by `convertKeyToPathSegment`, so the editor can find the position from the path.
 *
 * The recursion goes one call deeper per level of nesting. The YAML parser
 * used several calls per level and rejects YAML nested too deep for it, so
 * this function cannot overflow the call stack.
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
    // One Set per mapping keeps the duplicate check linear in the number of keys.
    const keys = new Set<string>();
    for (const pair of node.items) {
      if (isMap(pair.key) || isSeq(pair.key)) {
        issues.push({ path, message: NO_COLLECTION_KEYS });
        continue;
      }
      const key = convertKeyToPathSegment(pair.key);
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
 * The result of parsing a workflow's source: the YAML document, and either the
 * definition or the issues found.
 */
interface ParsedWorkflowDocument {
  /**
   * The YAML document, with each node's range in the source. The editor uses
   * it to find the position of an issue from its path, and to find what the
   * author is typing at the cursor. Absent when the source is too long to
   * parse.
   */
  readonly document: Document.Parsed | undefined;
  /** The start offset of each line, used to find the line of an offset. Absent when `document` is. */
  readonly lines: LineCounter | undefined;
  /**
   * The definition, or the issues: at most `MAX_ISSUES`, plus one issue that
   * counts the rest.
   */
  readonly result: Result.Result<WorkflowDefinition, ReadonlyArray<WorkflowSourceIssue>>;
}

/** The issue for a source that is too long to parse. */
const TOO_LONG_ISSUE: WorkflowSourceIssue = {
  path: [],
  // The message is about the workflow, not the text, because a definition
  // object is also measured by the length of its YAML.
  message: `A workflow can be at most ${String(MAX_WORKFLOW_SOURCE_LENGTH)} characters of YAML, and this one is longer. Shorten it.`,
};

/**
 * Parses a workflow's YAML source. Returns the YAML document and either the
 * definition or every issue found:
 *
 * - a source that is too long or not valid Unicode;
 * - YAML syntax errors;
 * - directives, tags, anchors, aliases and duplicate keys;
 * - everything `decodeWorkflowDefinition` rejects.
 *
 * The YAML document is returned too, so a caller that also needs positions in
 * the source parses it only once. The source itself is never changed.
 */
export const parseWorkflowDocument = (text: string): ParsedWorkflowDocument => {
  if (text.length > MAX_WORKFLOW_SOURCE_LENGTH) {
    return { document: undefined, lines: undefined, result: Result.fail([TOO_LONG_ISSUE]) };
  }
  const lines = new LineCounter();
  const document = parseDocument(text, {
    lineCounter: lines,
    prettyErrors: false,
    // The parser's own duplicate-key check compares each key with every
    // earlier key in its mapping, which takes quadratic time, and it misses
    // keys that are equal as strings, such as `1` and `"1"`.
    // `collectNodeIssues` checks the keys instead.
    uniqueKeys: false,
    // Treat `<<` as an ordinary key, as YAML 1.2 does.
    merge: false,
    // Do not decode tags such as `!!binary`. `collectNodeIssues` rejects every tag.
    resolveKnownTags: false,
  });
  const failWithIssues = (issues: ReadonlyArray<WorkflowSourceIssue>): ParsedWorkflowDocument => ({
    document,
    lines,
    result: Result.fail(truncateIssues(issues)),
  });
  const surrogate = text.search(LONE_SURROGATE);
  if (surrogate !== -1) {
    const { line, column } = findLineAndColumn(text, lines, surrogate);
    return failWithIssues([
      {
        path: [],
        message: `The text at line ${String(line)}, column ${String(column)} ${LONE_SURROGATE_MESSAGE}`,
        range: [surrogate, surrogate + 1],
      },
    ]);
  }
  if (document.errors.length > 0) {
    return failWithIssues(document.errors.map((error) => buildSyntaxIssue(text, error, lines)));
  }
  const issues: Array<WorkflowSourceIssue> = [
    ...listDirectiveIssues(text, document.range[0], lines),
  ];
  collectNodeIssues(document.contents, [], issues);
  if (issues.length > 0) return failWithIssues(issues);
  return { document, lines, result: decodeWorkflowDefinition(document.toJS()) };
};

/**
 * Parses a workflow's YAML source, as `parseWorkflowDocument` does. Returns
 * the definition, or the issues with only the path and message that the
 * public API sends.
 */
export const parseWorkflowSource = (
  text: string,
): Result.Result<WorkflowDefinition, ReadonlyArray<Issue>> =>
  Result.mapError(parseWorkflowDocument(text).result, (issues) => issues.map(buildPublicIssue));

/**
 * Puts the keys of every object in the order the definition schema declares
 * them. Marked pure, so a bundle that never renders YAML, such as the web
 * app's, can drop it.
 */
const orderDefinitionKeys = /* @__PURE__ */ Schema.encodeSync(WorkflowDefinition);

/**
 * Checks whether a string holds only spaces, tabs and line breaks, with at
 * least one line break. A block scalar treats leading lines of such whitespace
 * as indentation, so the string would not parse back unchanged from a block.
 * Such a string is double-quoted instead. Only YAML whitespace counts: a
 * no-break space is text to YAML, and a block can hold it. The YAML writer
 * already double-quotes a string with a carriage return.
 */
const isBlankLines = (text: string): boolean => text.includes("\n") && /^[ \t\n]*$/.test(text);

/** Returns a copy of the value in which each string that needs double quotes is marked for them. */
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
 * Converts a definition object to canonical YAML. The same object always
 * gives the same bytes:
 *
 * - Keys that the schema declares follow the schema's order, whatever order
 *   they were sent in.
 * - Keys that the author chooses keep the order in which they were sent,
 *   because the schema gives them no order. These are the keys in `params`,
 *   `options`, `outputSchema`, an input's `schema` and `default`, and a
 *   trigger's `inputs` and `outputs`.
 * - A string with a newline is a `|` block, and a string that needs quotes
 *   gets double quotes. A string of only whitespace and line breaks, or with
 *   a control character, cannot be held by a block, so it is double-quoted.
 * - Each level is indented by two spaces.
 * - No line is folded, because folding would be a second way to write the
 *   same string.
 */
export const renderWorkflowSource = (definition: WorkflowDefinition): string =>
  stringify(markDoubleQuotes(orderDefinitionKeys(definition)), {
    indent: 2,
    singleQuote: false,
    lineWidth: 0,
  });
