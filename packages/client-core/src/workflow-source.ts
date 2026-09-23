/**
 * How the browser reads a workflow's source: the one parse of the source, the
 * place in the source of each problem that the parse or the controller names,
 * which of those problems are true of the source that the author sees, and
 * their count in words.
 *
 * The controller names a problem by its path into the definition and never by
 * a position, so that the contract stays free of positions. The place is
 * found here, in the YAML document of the same parse, so a source is parsed
 * once however many problems are placed in it.
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
  spellPathKey,
  type Issue,
  type WorkflowDefinition,
  type WorkflowIssues,
} from "@hercule/contract";

/** How much a problem stops: an error stops a save, a warning does not. */
type IssueSeverity = "error" | "warning";

/**
 * A problem of a workflow's source, and the place in the source that it is
 * about. The line of the place is not here: the editor moves a mark with the
 * text that the author types, and says the line of the mark where it is then.
 */
export interface LocatedIssue extends Issue {
  readonly severity: IssueSeverity;
  /** The offset of the first character of the place. */
  readonly from: number;
  /** The offset after the last character of the place. */
  readonly to: number;
}

/** A workflow's source, as the one parse of it reads. */
export interface WorkflowSourceReading {
  readonly source: string;
  /** The YAML document of the source. Absent for a source too long to parse. */
  readonly document: Document.Parsed | undefined;
  /** Where each line of the source starts. Absent with `document`. */
  readonly lines: LineCounter | undefined;
  /** What the source says. Absent when the source has a problem that `issues` names. */
  readonly definition?: WorkflowDefinition;
  /** Each problem that stops the source from being a definition, at its place. */
  readonly issues: ReadonlyArray<LocatedIssue>;
}

/** The parts of a reading that give the place of a path. */
type SourcePlaces = Pick<WorkflowSourceReading, "source" | "document" | "lines">;

/** The offset of the first character of the line that holds an offset. */
export const findLineStart = (lines: LineCounter, offset: number): number =>
  offset - lines.linePos(offset).col + 1;

/**
 * The offset of the line break that ends the line that holds an offset, or
 * the end of the source on the last line. A line break is the `\n` that the
 * parse starts a new line after, and a `\r` before it stays in its line.
 */
export const findLineEnd = (source: string, lines: LineCounter, offset: number): number => {
  const nextLineStart = lines.lineStarts[lines.linePos(offset).line];
  return nextLineStart === undefined ? source.length : nextLineStart - 1;
};

/** A problem at the offsets `from` and `to` of a source, kept inside the source. */
const placeIssue = (
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
 * The offset after the last character between `from` and `to` that is not
 * white space. A mark on the white space or the line break at the end of a
 * line would reach past the text that the mark is about.
 */
const findContentEnd = (source: string, from: number, to: number): number => {
  let end = to;
  while (end > from && /\s/.test(source[end - 1] ?? "")) end -= 1;
  return end;
};

/**
 * The end of the mark of a problem that the parser found at a place in the
 * source. The parser often marks only the one character where a problem
 * starts, and a mark of one character is hard to see, so such a mark goes on
 * to the end of the line.
 */
const findParseMarkEnd = (source: string, lines: LineCounter, from: number, to: number): number =>
  to - from > 1 ? to : Math.max(to, findContentEnd(source, from, findLineEnd(source, lines, from)));

/** A node or a pair of the YAML document: the thing that a path into the definition names. */
type IssuePlace = Node | Pair<unknown, unknown>;

/**
 * The node or the pair that a path names, or `undefined` for a path that leads
 * nowhere in the source. A path that ends at a key names the pair of that key,
 * so a problem about the key and a problem about its value have one place.
 * Where the definition reads a key twice in one mapping, it reads the last
 * one, and a path names that one. A key that a mapping does not have, or a key
 * under a value that is not a mapping, names the place of that mapping or
 * value, where the key is missing. A path that goes on past that leads
 * nowhere.
 */
const findIssuePlace = (
  document: Document.Parsed,
  path: ReadonlyArray<string>,
): IssuePlace | undefined => {
  let place: unknown = document.contents;
  let node: unknown = document.contents;
  for (const [index, segment] of path.entries()) {
    const next: unknown = isMap(node)
      ? node.items.findLast((item) => spellPathKey(item.key) === segment)
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

/** The offsets in the source where a place starts and ends. A pair runs from its key through its value. */
const readPlaceRange = (place: IssuePlace): readonly [number, number] | undefined => {
  const first = isPair(place) ? place.key : place;
  const last = isPair(place) ? (place.value ?? place.key) : place;
  const start = isNode(first) ? first.range?.[0] : undefined;
  const end = isNode(last) ? last.range?.[1] : undefined;
  return start === undefined || end === undefined ? undefined : [start, end];
};

/**
 * A problem at the place in the source that its path names, marked on the
 * first line of the place only. A problem about a step, a list or a mapping
 * of fields is then marked on the line that starts it, and the marks of the
 * problems inside it stay visible. A problem whose path is empty, or leads
 * nowhere in the source, is placed at the start of the document, because a
 * mark under the whole source would hide every other mark.
 */
const placeIssueAtPath = (
  { source, document, lines }: SourcePlaces,
  issue: Issue,
  severity: IssueSeverity,
): LocatedIssue => {
  const place =
    document === undefined || issue.path.length === 0
      ? undefined
      : findIssuePlace(document, issue.path);
  const range = place === undefined ? undefined : readPlaceRange(place);
  // A source with a document has its line counter too.
  if (range === undefined || lines === undefined) return placeIssue(source, issue, severity, 0, 0);
  const [from, end] = range;
  const firstLineEnd = Math.min(end, findLineEnd(source, lines, from));
  return placeIssue(source, issue, severity, from, findContentEnd(source, from, firstLineEnd));
};

/**
 * Each problem that the controller names, at the place in the source that its
 * path names. The controller sends an empty path only with the problem that
 * counts the problems a long refusal leaves out, and that problem is placed at
 * the start of the document, as a problem whose path leads nowhere is.
 */
export const locateIssues = (
  reading: WorkflowSourceReading,
  issues: ReadonlyArray<Issue>,
  severity: IssueSeverity,
): ReadonlyArray<LocatedIssue> => issues.map((issue) => placeIssueAtPath(reading, issue, severity));

/**
 * Reads a workflow's source with the one parse that the controller uses too,
 * so the editor shows the problems that a save would be refused with. A
 * problem of the YAML itself is placed where the parser found it, and a
 * problem of the definition at its path.
 */
export const readWorkflowSource = (source: string): WorkflowSourceReading => {
  const { document, lines, result } = parseWorkflowDocument(source);
  const places: SourcePlaces = { source, document, lines };
  if (Result.isSuccess(result)) {
    return { ...places, definition: result.success, issues: [] };
  }
  return {
    ...places,
    issues: result.failure.map((issue) =>
      // Only a parsed source has a problem with a range, and a parsed source
      // has its line counter.
      issue.range === undefined || lines === undefined
        ? placeIssueAtPath(places, issue, "error")
        : placeIssue(
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
 * What the controller answered when it validated one source: its problems, or
 * why the validation failed.
 */
export type WorkflowValidation =
  | { readonly source: string; readonly issues: WorkflowIssues }
  | { readonly source: string; readonly reason: string };

/** How far the validation of a source has come. */
export type WorkflowValidationState =
  /** Every problem of the source is known: the parse's, or the controller's answer about this source. */
  | { readonly status: "validated" }
  /** The source parses, and the controller's answer about it is still to come. */
  | { readonly status: "validating" }
  /** The source parses, and the controller could not validate it, for the reason that `reason` gives. */
  | { readonly status: "failed"; readonly reason: string };

/**
 * How far the validation of a source has come, and the problems of the
 * source once they are known, errors first.
 */
type WorkflowIssueState =
  | { readonly status: "validated"; readonly issues: ReadonlyArray<LocatedIssue> }
  | Exclude<WorkflowValidationState, { readonly status: "validated" }>;

/**
 * How far the validation of a reading's source has come. A problem of the
 * parse wins, because the controller refuses a source that does not parse
 * with the same problems. The controller's answer is true only of the source
 * that it validated, so an answer about another source says nothing of this
 * one: the problems of this source stay unknown until the controller answers
 * about it.
 */
export const decideIssueState = (
  reading: WorkflowSourceReading,
  validation: WorkflowValidation | undefined,
): WorkflowIssueState => {
  if (reading.issues.length > 0) return { status: "validated", issues: reading.issues };
  if (validation?.source !== reading.source) return { status: "validating" };
  if ("reason" in validation) return { status: "failed", reason: validation.reason };
  return {
    status: "validated",
    issues: [
      ...locateIssues(reading, validation.issues.errors, "error"),
      ...locateIssues(reading, validation.issues.warnings, "warning"),
    ],
  };
};

/** How many problems a source has, in words: "1 problem", "3 problems". */
export const formatProblemCount = (count: number): string =>
  `${String(count)} ${count === 1 ? "problem" : "problems"}`;
