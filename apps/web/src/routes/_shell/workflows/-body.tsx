import { useEffect, useEffectEvent, useRef, useState, type JSX } from "react";
import { useLocation } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient, Live, WorkflowValidationState } from "@hercule/client-core";
import { agentsQuery, eventKindsQuery, workflowActionsQuery } from "../../../app/queries";
import {
  WorkflowEditor,
  type MarkedIssue,
  type WorkflowEditorHandle,
  type WorkflowView,
} from "../../../screens/workflow-editor";
import { ProblemsPanel } from "./-problems";
import { isJustCreatedState } from "./-save";
import { useWorkflowValidation } from "./-validation";

/**
 * The body of a workflow's page, under its header: the editor, and the
 * problems of the source under it. The body owns the controller's validation
 * of the source, hands its answer to the editor, and lists what the editor
 * marks.
 */
export function WorkflowEditorBody({
  client,
  live,
  source,
  onSourceChange,
  view,
  onViewChange,
  isInert,
  onNameChange,
}: {
  readonly client: HerculeClient;
  readonly live: Live;
  readonly source: string;
  readonly onSourceChange: (source: string) => void;
  readonly view: WorkflowView;
  readonly onViewChange: (view: WorkflowView) => void;
  /** Whether the editor takes no input, as while a create is in flight. */
  readonly isInert: boolean;
  readonly onNameChange: (name: string | undefined) => void;
}): JSX.Element {
  const isJustCreated = useLocation({ select: (location) => isJustCreatedState(location.state) });
  // The route's loader read the three, as `prefetchWorkflowCatalog` says.
  const catalog = {
    actions: useSuspenseQuery(workflowActionsQuery(client)).data,
    eventKinds: useSuspenseQuery(eventKindsQuery(client)).data,
    agents: useSuspenseQuery(agentsQuery(client)).data.items,
  };
  const validation = useWorkflowValidation(client, live, source);
  const [issues, setIssues] = useState<ReadonlyArray<MarkedIssue>>([]);
  const [validationState, setValidationState] = useState<WorkflowValidationState>({
    status: "validating",
  });
  const editor = useRef<WorkflowEditorHandle>(null);

  // After a create, the author goes on writing on the new page, so the focus
  // goes to the start of the text. The graph view shows no text to focus.
  const focusTextAfterCreate = useEffectEvent(() => {
    if (isJustCreated && view !== "graph") editor.current?.moveCursorToLine(1);
  });
  useEffect(() => {
    focusTextAfterCreate();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-8 pt-4 pb-6">
      {/* The editor is laid over the room that is left, so a long source
          scrolls inside the editor and the page is never taller than the
          window. */}
      <div className="relative min-h-0 flex-1" inert={isInert}>
        <div className="absolute inset-0">
          <WorkflowEditor
            ref={editor}
            source={source}
            onSourceChange={onSourceChange}
            view={view}
            catalog={catalog}
            validation={validation}
            onIssuesChange={setIssues}
            onValidationStateChange={setValidationState}
            onNameChange={onNameChange}
          />
        </div>
      </div>
      <ProblemsPanel
        issues={issues}
        validationState={validationState}
        onIssueClick={(issue) => {
          // The editor moves the cursor once the text shows, after the view changes.
          if (view === "graph") onViewChange("split");
          editor.current?.moveCursorToLine(issue.line);
        }}
      />
    </div>
  );
}
