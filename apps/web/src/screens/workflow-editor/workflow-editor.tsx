/**
 * The workflow editor: a YAML text editor with completion and error
 * underlines, and a graph of the workflow beside it.
 *
 * Each source is parsed once, with the same parse the controller runs. That
 * parse gives the YAML and schema errors, the graph, and the cursor context
 * for completion. The parent passes in the controller's validation result,
 * which covers the rest: actions, agents, expressions and graph rules.
 *
 * A validation result applies only to the exact source the controller
 * validated. While the author keeps typing, the underlines from the last
 * result move with the text, until the result for the new source replaces
 * them. The parent receives every underlined issue with its current position.
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
  parseWorkflowSourceWithRanges,
  type LocatedIssue,
  type WorkflowCatalog,
  type ParsedWorkflowSource,
  type WorkflowValidation,
  type WorkflowValidationState,
} from "@hercule/client-core";
import { cn } from "@hercule/ui";
import { GraphView } from "./graph-view/graph-view";
import { TextEditor, type TextEditorHandle } from "./text-editor/text-editor";

/**
 * How many parsed sources the cache keeps. The render parses the parent's
 * `source`, and completion parses the editor's current text. When the parent
 * passes the text back a few keystrokes late, the two alternate between
 * different sources. The cache holds the sources in between, so each source
 * is parsed only once.
 */
const PARSE_CACHE_SIZE = 8;

const NO_ISSUES: ReadonlyArray<LocatedIssue> = [];

/** The editor's layout: the text alone, the graph alone, or both side by side. */
export type WorkflowView = "yaml" | "graph" | "split";

/**
 * An issue as underlined in the text. `from` and `to` are the underline's
 * current position, which moves as the author types. `line` is the 1-based
 * line where the underline starts.
 */
export type MarkedIssue = LocatedIssue & { readonly line: number };

export interface WorkflowEditorHandle {
  /**
   * Puts the cursor at the start of a 1-based line and focuses the text
   * editor. The screen calls it after a view change has rendered. When the
   * text is hidden, as in the graph view, the cursor moves when the text is
   * shown again.
   */
  moveCursorToLine: (line: number) => void;
}

interface WorkflowEditorProps {
  /** The workflow's YAML source. The parent owns it and passes each change back in. */
  readonly source: string;
  readonly onSourceChange: (source: string) => void;
  readonly view: WorkflowView;
  readonly catalog: WorkflowCatalog;
  /**
   * The controller's latest validation result: its issues, or the reason
   * validation failed. `undefined` before the first result, and while the
   * controller retries a source it could not validate. A result for a
   * different source does not apply to `source`, but its underlines stay
   * until the result for `source` arrives.
   */
  readonly validation: WorkflowValidation | undefined;
  /**
   * Called with the underlined issues, errors first, each at its current
   * underline position, whenever the issues or their positions change. Parse
   * errors are underlined at once. While the controller's result for the
   * current source is pending, the underlines from its last result stay and
   * move with the text.
   */
  readonly onIssuesChange: (issues: ReadonlyArray<MarkedIssue>) => void;
  /**
   * Called whenever the validation status changes. For a source that does not
   * parse, the parse errors are the result, and they are known at once.
   */
  readonly onValidationStateChange: (state: WorkflowValidationState) => void;
  /**
   * Called whenever the workflow's name changes. While the source does not
   * parse as a workflow, the name comes from the last source that did,
   * because the graph also shows that source.
   */
  readonly onNameChange: (name: string | undefined) => void;
  readonly ref?: Ref<WorkflowEditorHandle>;
}

/** Creates a parse function that caches the results for the last few sources. */
const createCachedSourceParser = () => {
  const cache = new Map<string, ParsedWorkflowSource>();
  return (source: string): ParsedWorkflowSource => {
    const parsed = cache.get(source) ?? parseWorkflowSourceWithRanges(source);
    // Re-inserting moves the source to the end of the Map, so the least
    // recently used source is always first and is evicted first.
    cache.delete(source);
    cache.set(source, parsed);
    for (const [oldest] of cache) {
      if (cache.size <= PARSE_CACHE_SIZE) break;
      cache.delete(oldest);
    }
    return parsed;
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
  const [parseSource] = useState(createCachedSourceParser);
  const parsed = parseSource(source);
  const hasDefinition = parsed.definition !== undefined;

  // The last definition parsed from the author's text. The graph keeps
  // showing it while the current source does not parse. When the parent
  // replaces the text, the old definition no longer applies, so it is
  // dropped.
  const [lastDefinition, setLastDefinition] = useState(parsed.definition);
  if (parsed.definition !== undefined && parsed.definition !== lastDefinition) {
    setLastDefinition(parsed.definition);
  }
  const forgetLastDefinition = () => {
    setLastDefinition(parsed.definition);
  };

  const issueState = useMemo(() => decideIssueState(parsed, validation), [parsed, validation]);
  // Whether the current underlines come from a controller result. While the
  // result for the next source is pending, the controller's underlines stay
  // and move with the text. Parse error underlines do not stay: they belong
  // to a source that did not parse, and the current source parses without
  // errors. A failed validation request is not an error in the source, so it
  // clears the underlines.
  const [isMarkedByController, setIsMarkedByController] = useState(false);
  const isMarkedByControllerNow =
    issueState.status === "validated"
      ? parsed.issues.length === 0
      : issueState.status === "validating" && isMarkedByController;
  if (isMarkedByControllerNow !== isMarkedByController) {
    setIsMarkedByController(isMarkedByControllerNow);
  }
  const diagnostics =
    issueState.status === "validated"
      ? issueState.issues
      : isMarkedByControllerNow
        ? undefined
        : NO_ISSUES;

  // Notify the parent when the validation status or failure reason changes,
  // not when only the issues change.
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

  const drawnDefinition = parsed.definition ?? lastDefinition;
  const graph = useMemo(
    () => (drawnDefinition === undefined ? undefined : buildWorkflowGraph(drawnDefinition)),
    [drawnDefinition],
  );

  // A layout effect, so a parent that displays the name updates it before
  // paint, and never shows a placeholder for one frame.
  const drawnName = drawnDefinition?.name;
  const reportName = useEffectEvent(() => {
    onNameChange(drawnName);
  });
  useLayoutEffect(() => {
    reportName();
  }, [drawnName]);

  // The line to move the cursor to once the text editor is shown. A hidden
  // editor cannot take focus.
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
      {/* The text editor stays mounted in the graph view, so its cursor and undo history survive a view change. */}
      <div hidden={!isTextShown} className="min-w-0 flex-1">
        <TextEditor
          ref={textEditor}
          text={source}
          onTextChange={onSourceChange}
          onTextReplace={forgetLastDefinition}
          diagnostics={diagnostics}
          onDiagnosticsChange={onIssuesChange}
          completionSource={(typedSource, offset) =>
            listWorkflowCompletions(parseSource(typedSource), offset, catalog)
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
          {/* The note has its own row above the graph, so it never covers a card. The row is there even with no note, so the graph does not move or resize when the note appears or disappears. */}
          <p className="h-9 shrink-0 truncate px-4 text-fine leading-9 text-muted">{graphNote}</p>
          <div className="min-h-0 flex-1">
            {graph === undefined ? null : <GraphView graph={graph} isStale={!hasDefinition} />}
          </div>
        </section>
      )}
    </div>
  );
}
