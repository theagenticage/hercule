/**
 * How the browser reads a workflow's text: the one parse of the text, the
 * place in the text of each problem that the parse or the controller names,
 * and which of those problems are true of the text that the author sees.
 *
 * The controller names a problem by its path into the definition and never by
 * a position, so that the contract stays free of positions. The place is
 * found here, in the YAML document of the same parse, so a text is parsed once
 * however many problems are placed in it.
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

/** A problem of a workflow's text, and the place in the text that it is about. */
export interface LocatedIssue extends Issue {
  readonly severity: IssueSeverity;
  /** The offset of the first character of the place. */
  readonly from: number;
  /** The offset after the last character of the place. */
  readonly to: number;
  /** The line of `from`, counted from 1. */
  readonly line: number;
}

/** A workflow's text, as the one parse of it reads. */
export interface WorkflowSourceReading {
  readonly text: string;
  /** The YAML document of the text. Absent for a text too long to parse. */
  readonly document: Document.Parsed | undefined;
  /** Where each line of the text starts. Absent with `document`. */
  readonly lines: LineCounter | undefined;
  /** What the text says. Absent when the text has a problem that `issues` names. */
  readonly definition?: WorkflowDefinition;
  /** Each problem that stops the text from being a definition, at its place. */
  readonly issues: ReadonlyArray<LocatedIssue>;
}

/** The parts of a reading that give the place and the line of an offset. */
type TextPlaces = Pick<WorkflowSourceReading, "text" | "document" | "lines">;

/** A problem at the offsets `from` and `to` of a text, kept inside the text. */
const placeIssue = (
  { text, lines }: TextPlaces,
  issue: Issue,
  severity: IssueSeverity,
  from: number,
  to: number,
): LocatedIssue => {
  const start = Math.min(Math.max(from, 0), text.length);
  const end = Math.min(Math.max(to, start), text.length);
  return {
    severity,
    path: issue.path,
    message: issue.message,
    from: start,
    to: end,
    // A text too long to parse has no line counter. Its one problem is at
    // its start, on line 1.
    line: lines?.linePos(start).line ?? 1,
  };
};

/**
 * The offset after the last character between `from` and `to` that is not
 * white space. A mark on the white space or the line break at the end of a
 * line would reach past the text that the mark is about.
 */
const findContentEnd = (text: string, from: number, to: number): number => {
  let end = to;
  while (end > from && /\s/.test(text[end - 1] ?? "")) end -= 1;
  return end;
};

/**
 * The end of the mark of a problem that the parser found at a place in the
 * text. The parser often marks only the one character where a problem starts,
 * and a mark of one character is hard to see, so such a mark goes on to the
 * end of the line.
 */
const findParseMarkEnd = (text: string, from: number, to: number): number => {
  if (to - from > 1) return to;
  const lineEnd = text.indexOf("\n", from);
  return Math.max(to, findContentEnd(text, from, lineEnd === -1 ? text.length : lineEnd));
};

/** A node or a pair of the YAML document: the thing that a path into the definition names. */
type IssuePlace = Node | Pair<unknown, unknown>;

/**
 * The node or the pair that a path names, or `undefined` for a path that leads
 * nowhere in the text. A path that ends at a key names the pair of that key,
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

/** The offsets in the text where a place starts and ends. A pair runs from its key through its value. */
const readPlaceRange = (place: IssuePlace): readonly [number, number] | undefined => {
  const first = isPair(place) ? place.key : place;
  const last = isPair(place) ? (place.value ?? place.key) : place;
  const start = isNode(first) ? first.range?.[0] : undefined;
  const end = isNode(last) ? last.range?.[1] : undefined;
  return start === undefined || end === undefined ? undefined : [start, end];
};

/**
 * A problem at the place in the text that its path names, marked on the
 * first line of the place only. A problem about a step, a list or a mapping
 * of fields is then marked on the line that starts it, and the marks of the
 * problems inside it stay visible. A problem whose path is empty, or leads
 * nowhere in the text, is placed at the start of the document, because a mark
 * under the whole text would hide every other mark.
 */
const placeIssueAtPath = (
  reading: TextPlaces,
  issue: Issue,
  severity: IssueSeverity,
): LocatedIssue => {
  const place =
    reading.document === undefined || issue.path.length === 0
      ? undefined
      : findIssuePlace(reading.document, issue.path);
  const range = place === undefined ? undefined : readPlaceRange(place);
  if (range === undefined) return placeIssue(reading, issue, severity, 0, 0);
  const [from, end] = range;
  const lineEnd = reading.text.indexOf("\n", from);
  const firstLineEnd = lineEnd === -1 ? end : Math.min(end, lineEnd);
  return placeIssue(
    reading,
    issue,
    severity,
    from,
    findContentEnd(reading.text, from, firstLineEnd),
  );
};

/**
 * Each problem that the controller names, at the place in the text that its
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
 * Reads a workflow's text with the one parse that the controller uses too, so
 * the editor shows the problems that a save would be refused with. A problem
 * of the YAML itself is placed where the parser found it, and a problem of the
 * definition at its path.
 */
export const readWorkflowSource = (text: string): WorkflowSourceReading => {
  const { document, lines, result } = parseWorkflowDocument(text);
  const places: TextPlaces = { text, document, lines };
  if (Result.isSuccess(result)) {
    return { ...places, definition: result.success, issues: [] };
  }
  return {
    ...places,
    issues: result.failure.map((issue) =>
      issue.range === undefined
        ? placeIssueAtPath(places, issue, "error")
        : placeIssue(
            places,
            issue,
            "error",
            issue.range[0],
            findParseMarkEnd(text, ...issue.range),
          ),
    ),
  };
};

/** What the controller answered when it checked one text: its problems, or why the check failed. */
export type WorkflowValidation =
  | { readonly text: string; readonly issues: WorkflowIssues }
  | { readonly text: string; readonly reason: string };

/** How far the check of a text has come. */
export type WorkflowCheckState =
  /** Every problem of the text is known: the parse's, or the controller's answer about this text. */
  | { readonly status: "checked" }
  /** The text parses, and the controller's answer about it is still to come. */
  | { readonly status: "checking" }
  /** The text parses, and the controller could not check it, for the reason that `reason` gives. */
  | { readonly status: "failed"; readonly reason: string };

/** How far the check of a text has come, and the problems of the text once they are known, errors first. */
type WorkflowIssueState =
  | { readonly status: "checked"; readonly issues: ReadonlyArray<LocatedIssue> }
  | Exclude<WorkflowCheckState, { readonly status: "checked" }>;

/**
 * How far the check of a reading's text has come. A problem of the parse
 * wins, because the controller refuses a text that does not parse with the
 * same problems. The controller's answer is true only of the text that it
 * checked, so an answer about another text says nothing of this one: the
 * problems of this text stay unknown until the controller answers about it.
 */
export const decideIssueState = (
  reading: WorkflowSourceReading,
  validation: WorkflowValidation | undefined,
): WorkflowIssueState => {
  if (reading.issues.length > 0) return { status: "checked", issues: reading.issues };
  if (validation?.text !== reading.text) return { status: "checking" };
  if ("reason" in validation) return { status: "failed", reason: validation.reason };
  return {
    status: "checked",
    issues: [
      ...locateIssues(reading, validation.issues.errors, "error"),
      ...locateIssues(reading, validation.issues.warnings, "warning"),
    ],
  };
};
