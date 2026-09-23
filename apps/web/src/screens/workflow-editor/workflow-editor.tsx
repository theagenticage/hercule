/**
 * The workflow editor: a workflow's YAML source, with completion and a mark on
 * each problem, and the graph of the workflow beside it.
 *
 * Each source is read once, with the parse that the controller uses too. That
 * reading gives the problems of the YAML and of the shape at once, the graph,
 * and the place of the cursor for completion. The parent brings the
 * controller's answer about the rest: actions, agents, expressions and the
 * graph's rules. An answer is about the source that the controller validated
 * and no other. While the author types on, the marks of the last answer move
 * with the text, until the answer about the new source replaces them. The
 * parent hears of each problem that the text shows marked, at the place of
 * its mark.
 */
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type Ref,
} from "react";
import {
  buildWorkflowGraph,
  decideIssueState,
  listWorkflowCompletions,
  readWorkflowSource,
  type LocatedIssue,
  type WorkflowCatalog,
  type WorkflowSourceReading,
  type WorkflowValidation,
  type WorkflowValidationState,
} from "@hercule/client-core";
import { cn } from "@hercule/ui";
import { GraphView } from "./graph-view/graph-view";
import { TextEditor, type TextEditorHandle } from "./text-editor/text-editor";

/**
 * How many readings the reader keeps. The render reads the parent's source,
 * and the completion reads the editor's text. While the parent sends the
 * editor's texts back some keystrokes late, the two read different sources in
 * turn, and the reader keeps the readings of the sources between them, so
 * that each source is parsed once.
 */
const KEPT_READINGS = 8;

const NO_ISSUES: ReadonlyArray<LocatedIssue> = [];

/** What the editor shows: the text alone, the graph alone, or the two side by side. */
export type WorkflowView = "yaml" | "graph" | "split";

/**
 * A problem as the text shows it marked: at the place of its mark now, which
 * moves with the text that the author types, and on the line of that place,
 * counted from 1.
 */
export type MarkedIssue = LocatedIssue & { readonly line: number };

export interface WorkflowEditorHandle {
  /**
   * Puts the cursor at the start of a line, counted from 1, and focuses the
   * text. The screen calls it after a change of view has rendered. When the
   * text is hidden, as in the graph view, the cursor moves when the text shows
   * again.
   */
  moveCursorToLine: (line: number) => void;
}

interface WorkflowEditorProps {
  /** The workflow's YAML source. The parent owns it, and passes each change back in. */
  readonly source: string;
  readonly onSourceChange: (source: string) => void;
  readonly view: WorkflowView;
  readonly catalog: WorkflowCatalog;
  /**
   * The controller's last answer about a source: its problems, or why it
   * could not validate the source. Absent before the first answer, and while
   * the controller validates again a source that it could not validate. An
   * answer about another source than `source` says nothing of `source`, and
   * the marks of that answer stay until the answer about `source` comes.
   */
  readonly validation: WorkflowValidation | undefined;
  /**
   * Receives the problems that the text shows marked, errors first, each at
   * the place of its mark, each time they or their places change. The parse's
   * problems are marked at once. While the controller's answer about the
   * source is still to come, the marks of its last answer stay, and move with
   * the text that the author types.
   */
  readonly onIssuesChange: (issues: ReadonlyArray<MarkedIssue>) => void;
  /**
   * Receives how far the validation of the source has come, each time that
   * changes. The problems of a source that does not parse are the parse's,
   * and they are known at once.
   */
  readonly onValidationStateChange: (state: WorkflowValidationState) => void;
  /**
   * Receives the name that the source gives the workflow, each time it
   * changes. While the source does not read as a workflow, it is the name of
   * the last source that did, as the graph shows that source too.
   */
  readonly onNameChange: (name: string | undefined) => void;
  readonly ref?: Ref<WorkflowEditorHandle>;
}

/** A reader that parses each source once, and keeps the readings of the last few sources. */
const createSourceReader = () => {
  const readings = new Map<string, WorkflowSourceReading>();
  return (source: string): WorkflowSourceReading => {
    const reading = readings.get(source) ?? readWorkflowSource(source);
    // The newest reading goes last, so the oldest is the first to go.
    readings.delete(source);
    readings.set(source, reading);
    for (const [oldest] of readings) {
      if (readings.size <= KEPT_READINGS) break;
      readings.delete(oldest);
    }
    return reading;
  };
};

export function WorkflowEditor({
  source,
  onSourceChange,
  view,
  catalog,
  validation,
  onIssuesChange,
  onValidationStateChange,
  onNameChange,
  ref,
}: WorkflowEditorProps): JSX.Element {
  const [readSource] = useState(createSourceReader);
  const reading = readSource(source);
  const hasDefinition = reading.definition !== undefined;

  // The last definition that a source of the author gave, which the graph
  // keeps showing while the source does not give one. A source that the
  // parent puts in place of the author's is another source, and the
  // definition of the source before it says nothing of it.
  const [lastDefinition, setLastDefinition] = useState(reading.definition);
  if (reading.definition !== undefined && reading.definition !== lastDefinition) {
    setLastDefinition(reading.definition);
  }
  const forgetLastDefinition = () => {
    setLastDefinition(reading.definition);
  };

  const issueState = useMemo(() => decideIssueState(reading, validation), [reading, validation]);
  // Whether the marks in the text come from an answer of the controller.
  // While the answer about the next source is to come, the marks of an
  // answer stay and move with the text. The marks of the parse do not stay:
  // they are about a source that did not parse, and the parse of the source
  // now finds no problem. A failed validation is not a problem of the source,
  // so it clears the marks.
  const [isMarkedByAnswer, setIsMarkedByAnswer] = useState(false);
  const isMarkedByAnswerNow =
    issueState.status === "validated"
      ? reading.issues.length === 0
      : issueState.status === "validating" && isMarkedByAnswer;
  if (isMarkedByAnswerNow !== isMarkedByAnswer) setIsMarkedByAnswer(isMarkedByAnswerNow);
  const diagnostics =
    issueState.status === "validated"
      ? issueState.issues
      : isMarkedByAnswerNow
        ? undefined
        : NO_ISSUES;

  // The parent hears of the validation state when it changes, and not when
  // only the problems change.
  const validationStatus = issueState.status;
  const validationFailureReason = issueState.status === "failed" ? issueState.reason : undefined;
  const reportValidationState = useEffectEvent(() => {
    onValidationStateChange(
      issueState.status === "failed"
        ? { status: "failed", reason: issueState.reason }
        : { status: issueState.status },
    );
  });
  useEffect(() => {
    reportValidationState();
  }, [validationStatus, validationFailureReason]);

  const drawnDefinition = reading.definition ?? lastDefinition;
  const graph = useMemo(
    () => (drawnDefinition === undefined ? undefined : buildWorkflowGraph(drawnDefinition)),
    [drawnDefinition],
  );

  // A layout effect, so that a parent that shows the name shows it before
  // the page is painted, and never a stand-in for one frame.
  const drawnName = drawnDefinition?.name;
  const reportName = useEffectEvent(() => {
    onNameChange(drawnName);
  });
  useLayoutEffect(() => {
    reportName();
  }, [drawnName]);

  // A line to move the cursor to once the text shows, because a hidden text
  // cannot take focus.
  const textEditor = useRef<TextEditorHandle>(null);
  const pendingLine = useRef<number | undefined>(undefined);
  const isTextShown = view !== "graph";
  useEffect(() => {
    const line = pendingLine.current;
    if (!isTextShown || line === undefined) return;
    pendingLine.current = undefined;
    textEditor.current?.moveCursorToLine(line);
  }, [isTextShown]);
  useImperativeHandle(
    ref,
    () => ({
      moveCursorToLine: (line) => {
        if (isTextShown) textEditor.current?.moveCursorToLine(line);
        else pendingLine.current = line;
      },
    }),
    [isTextShown],
  );

  const graphNote =
    graph === undefined
      ? "The graph appears when the text reads as a workflow."
      : hasDefinition
        ? undefined
        : "The text does not read as a workflow. The graph shows the last version that did.";

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden rounded-card border border-line bg-raised shadow-card">
      {/* The text stays mounted in the graph view, so its cursor and its undo history survive a change of view. */}
      <div hidden={!isTextShown} className="min-w-0 flex-1">
        <TextEditor
          ref={textEditor}
          text={source}
          onTextChange={onSourceChange}
          onTextReplace={forgetLastDefinition}
          diagnostics={diagnostics}
          onDiagnosticsChange={onIssuesChange}
          completionSource={(typedSource, offset) =>
            listWorkflowCompletions(readSource(typedSource), offset, catalog)
          }
        />
      </div>
      {view === "yaml" ? null : (
        <section
          aria-label="Workflow graph"
          className={cn(
            "flex min-w-0 flex-1 flex-col bg-surface",
            view === "split" && "border-l border-line",
          )}
        >
          {/* The note has a line of its own above the graph, so it never covers a card. The line is there with no note too, so the graph keeps its size, and its place, when the note comes and goes. */}
          <p className="h-9 shrink-0 truncate px-4 text-fine leading-9 text-muted">{graphNote}</p>
          <div className="min-h-0 flex-1">
            {graph === undefined ? null : <GraphView graph={graph} isStale={!hasDefinition} />}
          </div>
        </section>
      )}
    </div>
  );
}
