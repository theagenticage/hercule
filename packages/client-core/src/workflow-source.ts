/**
 * Parses a workflow's YAML source in the browser and finds where in the text
 * each problem is.
 *
 * A problem comes from one of two places:
 * - the YAML parse or the schema check, which run here, or
 * - the controller's validation, which reports each problem with a path into
 *   the definition, such as `["steps", "1", "action"]`, and no text offset.
 *
 * This module converts each path to a text range, using the YAML document
 * from the parse. The source is parsed only once, however many problems it has.
 */
import { Result } from "effect";
import {
  isMap,
  isNode,
  isPair,
  isSeq,
  type Document,
  type LineCounter,
  type Node,
  type Pair,
} from "yaml";
import {
  parseWorkflowDocument,
  convertKeyToPathSegment,
  type Issue,
  type WorkflowDefinition,
  type WorkflowIssues,
} from "@hercule/contract";

/** An error blocks a save. A warning does not. */
type IssueSeverity = "error" | "warning";

/**
 * A problem in a workflow's source, with the text range it applies to.
 *
 * There is no line number. While the author types, the editor moves the
 * underline with the text and computes the line from the underline's
 * current position.
 */
export interface LocatedIssue extends Issue {
  readonly severity: IssueSeverity;
  /** The offset of the first character of the range. */
  readonly from: number;
  /** The offset just after the last character of the range. */
  readonly to: number;
}

/** The result of parsing a workflow's YAML source. */
export interface ParsedWorkflowSource {
  readonly source: string;
  /** The YAML document. `undefined` when the source is too long to parse. */
  readonly document: Document.Parsed | undefined;
  /** The start offset of each line. `undefined` exactly when `document` is. */
  readonly lines: LineCounter | undefined;
  /** The parsed definition. Missing when `issues` is not empty. */
  readonly definition?: WorkflowDefinition;
  /** Every YAML or schema error in the source, with its text range. */
  readonly issues: ReadonlyArray<LocatedIssue>;
}

/** The fields needed to convert a path into a text range. */
type SourcePlaces = Pick<ParsedWorkflowSource, "source" | "document" | "lines">;

/** Returns the offset where the line that contains `offset` starts. */
export const findLineStart = (lines: LineCounter, offset: number): number =>
  offset - lines.linePos(offset).col + 1;

/**
 * Returns the offset of the `\n` that ends the line containing `offset`, or
 * the source length on the last line. A `\r` before the `\n` counts as part
 * of the line, because the YAML line counter starts each line after the `\n`.
 */
export const findLineEnd = (source: string, lines: LineCounter, offset: number): number => {
  const nextLineStart = lines.lineStarts[lines.linePos(offset).line];
  return nextLineStart === undefined ? source.length : nextLineStart - 1;
};

/** Builds a located issue, clamping `from` and `to` to the source's bounds. */
const buildLocatedIssue = (
  source: string,
  issue: Issue,
  severity: IssueSeverity,
  from: number,
  to: number,
): LocatedIssue => {
  const start = Math.min(Math.max(from, 0), source.length);
  return {
    severity,
    path: issue.path,
    message: issue.message,
    from: start,
    to: Math.min(Math.max(to, start), source.length),
  };
};

/**
 * Returns `to` moved back past any trailing whitespace, but not before
 * `from`. Without the trim, an underline would extend past the text into the
 * spaces and line break at the end of the line.
 */
const findContentEnd = (source: string, from: number, to: number): number => {
  let end = to;
  while (end > from && /\s/.test(source[end - 1] ?? "")) end -= 1;
  return end;
};

/**
 * Returns the end offset of the underline for a YAML parse error. The parser
 * often reports a range of one character, which is hard to see. So a range
 * that short is extended to the end of the line's text.
 */
const findParseMarkEnd = (source: string, lines: LineCounter, from: number, to: number): number =>
  to - from > 1 ? to : Math.max(to, findContentEnd(source, from, findLineEnd(source, lines, from)));

/** The YAML node or key-value pair that a definition path points to. */
type IssuePlace = Node | Pair<unknown, unknown>;

/**
 * Returns the YAML node or pair that a definition path points to, or
 * `undefined` when the path is not in the document.
 *
 * - A path that ends at a mapping key returns the whole key-value pair, so a
 *   problem with the key and a problem with its value get the same range.
 * - When a mapping has the same key twice, the last one wins, as it does in
 *   the parsed definition.
 * - When the last segment is a key that is missing, the parent mapping or
 *   value is returned, because that is where the key should be. A missing
 *   segment before the last one returns `undefined`.
 */
const findIssuePlace = (
  document: Document.Parsed,
  path: ReadonlyArray<string>,
): IssuePlace | undefined => {
  let place: unknown = document.contents;
  let node: unknown = document.contents;
  for (const [index, segment] of path.entries()) {
    const next: unknown = isMap(node)
      ? node.items.findLast((item) => convertKeyToPathSegment(item.key) === segment)
      : isSeq(node) && /^\d+$/.test(segment)
        ? node.items[Number(segment)]
        : undefined;
    if (next === undefined) {
      const isLast = index === path.length - 1;
      return isLast && !isSeq(node) && (isNode(place) || isPair(place)) ? place : undefined;
    }
    place = next;
    node = isPair(next) ? next.value : next;
  }
  return isNode(place) || isPair(place) ? place : undefined;
};

/** Returns the start and end offsets of a node, or of a pair from its key through its value. */
const readPlaceRange = (place: IssuePlace): readonly [number, number] | undefined => {
  const first = isPair(place) ? place.key : place;
  const last = isPair(place) ? (place.value ?? place.key) : place;
  const start = isNode(first) ? first.range?.[0] : undefined;
  const end = isNode(last) ? last.range?.[1] : undefined;
  return start === undefined || end === undefined ? undefined : [start, end];
};

/**
 * Locates an issue by its path. The range covers only the first line of the
 * node, so a problem with a whole step or list underlines only its first
 * line, and the underlines of problems inside it stay visible.
 *
 * An issue with an empty path, or a path not in the document, gets an empty
 * range at offset 0. Underlining the whole source would hide every other
 * underline.
 */
const locateIssueAtPath = (
  { source, document, lines }: SourcePlaces,
  issue: Issue,
  severity: IssueSeverity,
): LocatedIssue => {
  const place =
    document === undefined || issue.path.length === 0
      ? undefined
      : findIssuePlace(document, issue.path);
  const range = place === undefined ? undefined : readPlaceRange(place);
  // `lines` is always set when `document` is, so the check only narrows the type.
  if (range === undefined || lines === undefined) {
    return buildLocatedIssue(source, issue, severity, 0, 0);
  }
  const [from, end] = range;
  const firstLineEnd = Math.min(end, findLineEnd(source, lines, from));
  return buildLocatedIssue(
    source,
    issue,
    severity,
    from,
    findContentEnd(source, from, firstLineEnd),
  );
};

/**
 * Returns the controller's issues with the text range of each one's path.
 *
 * The controller sends an empty path only for the summary issue that counts
 * the problems left out of a long list ("3 more problems."). That issue gets
 * an empty range at offset 0.
 */
export const locateIssues = (
  parsed: ParsedWorkflowSource,
  issues: ReadonlyArray<Issue>,
  severity: IssueSeverity,
): ReadonlyArray<LocatedIssue> => issues.map((issue) => locateIssueAtPath(parsed, issue, severity));

/**
 * Parses a workflow's YAML source and validates it against the workflow
 * schema. Returns the definition, or every error with its text range.
 *
 * The controller runs the same parse, so the editor shows the same errors a
 * save would fail with. A YAML syntax error gets the range the parser
 * reports. A schema error gets the range of its path.
 */
export const parseWorkflowSourceWithRanges = (source: string): ParsedWorkflowSource => {
  const { document, lines, result } = parseWorkflowDocument(source);
  const places: SourcePlaces = { source, document, lines };
  if (Result.isSuccess(result)) {
    return { ...places, definition: result.success, issues: [] };
  }
  return {
    ...places,
    issues: result.failure.map((issue) =>
      // Only YAML syntax errors have a range, and those come with `lines` set.
      issue.range === undefined || lines === undefined
        ? locateIssueAtPath(places, issue, "error")
        : buildLocatedIssue(
            source,
            issue,
            "error",
            issue.range[0],
            findParseMarkEnd(source, lines, ...issue.range),
          ),
    ),
  };
};

/**
 * The controller's validation result for one source: its errors and warnings,
 * or the reason the request failed.
 */
export type WorkflowValidation =
  | { readonly source: string; readonly issues: WorkflowIssues }
  | { readonly source: string; readonly reason: string };

/** The validation progress of the source in the editor. */
export type WorkflowValidationState =
  /** All problems are known, either from the local parse or from the controller. */
  | { readonly status: "validated" }
  /** The source parses, and the controller's result is not back yet. */
  | { readonly status: "validating" }
  /** The source parses, but the request to the controller failed. */
  | { readonly status: "failed"; readonly reason: string };

/** The validation progress, with the issues once they are known, errors first. */
type WorkflowIssueState =
  | { readonly status: "validated"; readonly issues: ReadonlyArray<LocatedIssue> }
  | Exclude<WorkflowValidationState, { readonly status: "validated" }>;

/**
 * Returns the validation progress of a parsed source, and its issues once they
 * are known.
 *
 * - If the local parse found errors, those are the result. The controller
 *   would fail the source with the same errors.
 * - Otherwise the controller's result is used, but only if it is for this
 *   exact source text. A result for an older text does not apply to the
 *   current one, so the status stays `validating` until the new result arrives.
 */
export const decideIssueState = (
  parsed: ParsedWorkflowSource,
  validation: WorkflowValidation | undefined,
): WorkflowIssueState => {
  if (parsed.issues.length > 0) return { status: "validated", issues: parsed.issues };
  if (validation?.source !== parsed.source) return { status: "validating" };
  if ("reason" in validation) return { status: "failed", reason: validation.reason };
  return {
    status: "validated",
    issues: [
      ...locateIssues(parsed, validation.issues.errors, "error"),
      ...locateIssues(parsed, validation.issues.warnings, "warning"),
    ],
  };
};

/** Formats a problem count for display: "1 problem", "3 problems". */
export const formatProblemCount = (count: number): string =>
  `${String(count)} ${count === 1 ? "problem" : "problems"}`;
