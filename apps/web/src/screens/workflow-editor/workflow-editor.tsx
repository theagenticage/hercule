/**
 * The workflow editor: a workflow's YAML text, with completion and a mark on
 * each problem, and the graph of the workflow beside it.
 *
 * Each text is read once, with the parse that the controller uses too. That
 * reading gives the problems of the YAML and of the shape at once, the graph,
 * and the place of the cursor for completion. About 400 ms after the author
 * stops typing, the controller checks the rest: actions, agents, expressions
 * and the graph's rules. Its answer is about the text that it checked and no
 * other. While the author types on, the marks of the last answer move with
 * the text, until the answer about the new text replaces them. A refused save
 * is an answer about its text too, and its errors are marked in place of the
 * last check's. The parent hears of each problem that the text shows marked,
 * at the place of its mark.
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
import type { Issue, WorkflowIssues } from "@hercule/contract";
import {
  buildWorkflowGraph,
  decideIssueState,
  listWorkflowCompletions,
  readWorkflowSource,
  type LocatedIssue,
  type WorkflowCatalog,
  type WorkflowCheckState,
  type WorkflowSourceReading,
  type WorkflowValidation,
} from "@hercule/client-core";
import { cn } from "@hercule/ui";
import { readErrorMessage } from "../save-status";
import { GraphView } from "./graph-view/graph-view";
import { TextEditor, type TextEditorHandle } from "./text-editor/text-editor";

/** How long the text must stay unchanged before the controller checks it. */
const VALIDATION_DELAY_MS = 400;

/**
 * How many readings the reader keeps. The render reads the parent's text, and
 * the completion reads the editor's text. While the parent sends the editor's
 * texts back some keystrokes late, the two read different texts in turn, and
 * the reader keeps the readings of the texts between them, so that each text
 * is parsed once.
 */
const KEPT_READINGS = 8;

const NO_ISSUES: ReadonlyArray<LocatedIssue> = [];

export interface WorkflowEditorHandle {
  /**
   * Puts the cursor at the start of a line, counted from 1, and focuses the
   * text. The screen calls it after a change of view has rendered. When the
   * text is hidden, as in the graph view, the cursor moves when the text shows
   * again.
   */
  moveCursorToLine: (line: number) => void;
  /**
   * Marks the errors that the controller refused a save of `source` with, in
   * place of the errors of the last answer about that text. A refusal is an
   * answer about its text as a check is, and the last answer to arrive wins:
   * a check of the same text that answers after the refusal replaces its
   * errors. The warnings of a check of the same text stay, because a refusal
   * names errors only. A refusal of a text that the editor no longer holds
   * changes nothing.
   */
  markSaveRefusal: (source: string, errors: ReadonlyArray<Issue>) => void;
  /**
   * Checks the text again when the last check of it could not run, as when
   * the controller could not be reached. An answer about the text stands, so
   * a call when there is one changes nothing.
   */
  checkAgain: () => void;
}

interface WorkflowEditorProps {
  /** The workflow's YAML text. The parent owns it, and passes each change back in. */
  readonly source: string;
  readonly onSourceChange: (source: string) => void;
  /** The text alone, the graph alone, or the two side by side. */
  readonly view: "yaml" | "graph" | "split";
  readonly catalog: WorkflowCatalog;
  /** Checks a text as a save would, on the controller, and stores nothing. */
  readonly validate: (source: string) => Promise<WorkflowIssues>;
  /**
   * Receives the problems that the text shows marked, errors first, each at
   * the place of its mark, each time they or their places change. The parse's
   * problems are marked at once. While the controller's answer about the text
   * is still to come, the marks of its last answer stay, and move with the
   * text that the author types.
   */
  readonly onIssuesChange: (issues: ReadonlyArray<LocatedIssue>) => void;
  /** Receives how far the check of the text has come, each time that changes. */
  readonly onCheckStateChange: (state: WorkflowCheckState) => void;
  /**
   * Receives the name that the text gives the workflow, each time it changes.
   * While the text does not read as a workflow, it is the name of the last
   * text that did, as the graph shows that text too.
   */
  readonly onNameChange: (name: string | undefined) => void;
  readonly ref?: Ref<WorkflowEditorHandle>;
}

/** A reader that parses each text once, and keeps the readings of the last few texts. */
const createSourceReader = () => {
  const readings = new Map<string, WorkflowSourceReading>();
  return (text: string): WorkflowSourceReading => {
    const reading = readings.get(text) ?? readWorkflowSource(text);
    // The newest reading goes last, so the oldest is the first to go.
    readings.delete(text);
    readings.set(text, reading);
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
  validate,
  onIssuesChange,
  onCheckStateChange,
  onNameChange,
  ref,
}: WorkflowEditorProps): JSX.Element {
  const [readSource] = useState(createSourceReader);
  const reading = readSource(source);
  const hasDefinition = reading.definition !== undefined;

  // The last definition that a text of the author gave, which the graph keeps
  // showing while the text does not give one. A text that the parent puts in
  // place of the author's is another text, and the definition of the text
  // before it says nothing of it.
  const [lastDefinition, setLastDefinition] = useState(reading.definition);
  if (reading.definition !== undefined && reading.definition !== lastDefinition) {
    setLastDefinition(reading.definition);
  }
  const forgetLastDefinition = () => {
    setLastDefinition(reading.definition);
  };

  // The controller's last answer. The marks of a text that does not parse are
  // the parse's, and they replace the marks of the answer, so the answer goes.
  const [validation, setValidation] = useState<WorkflowValidation>();
  if (!hasDefinition && validation !== undefined) setValidation(undefined);

  // Each call of `checkAgain` that asks for a check starts one more round.
  const [checkRound, setCheckRound] = useState(0);
  const requestValidation = useEffectEvent((text: string) => validate(text));
  useEffect(() => {
    // A text that does not parse gets the parse's problems from the
    // controller too, and the editor shows those already.
    if (!hasDefinition) return;
    // An answer about a text that has changed since is not kept.
    let isCurrent = true;
    const timer = setTimeout(() => {
      requestValidation(source).then(
        (issues) => {
          if (isCurrent) setValidation({ text: source, issues });
        },
        (error: unknown) => {
          if (isCurrent) setValidation({ text: source, reason: readErrorMessage(error) });
        },
      );
    }, VALIDATION_DELAY_MS);
    return () => {
      isCurrent = false;
      clearTimeout(timer);
    };
  }, [source, hasDefinition, checkRound]);

  const issueState = useMemo(() => decideIssueState(reading, validation), [reading, validation]);
  // While the answer about this text is still to come, the marks of the last
  // answer stay and move with the text. A failed check is not a problem of
  // the text, so it clears the marks.
  const diagnostics =
    issueState.status === "checked"
      ? issueState.issues
      : issueState.status === "checking" && validation !== undefined
        ? undefined
        : NO_ISSUES;

  // The parent hears of the check state when it changes, and not when only
  // the problems change.
  const checkStatus = issueState.status;
  const checkFailureReason = issueState.status === "failed" ? issueState.reason : undefined;
  const reportCheckState = useEffectEvent(() => {
    onCheckStateChange(
      issueState.status === "failed"
        ? { status: "failed", reason: issueState.reason }
        : { status: issueState.status },
    );
  });
  useEffect(() => {
    reportCheckState();
  }, [checkStatus, checkFailureReason]);

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
      markSaveRefusal: (refused, errors) => {
        if (refused !== source) return;
        setValidation((last) => ({
          text: refused,
          issues: {
            errors,
            warnings: last?.text === refused && "issues" in last ? last.issues.warnings : [],
          },
        }));
      },
      checkAgain: () => {
        if (issueState.status !== "failed") return;
        setValidation(undefined);
        setCheckRound((round) => round + 1);
      },
    }),
    [isTextShown, source, issueState.status],
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
          completionSource={(text, offset) =>
            listWorkflowCompletions(readSource(text), offset, catalog)
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
