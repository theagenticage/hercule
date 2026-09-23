import { useEffect, useEffectEvent, useRef, useState, type JSX } from "react";
import { useBlocker, useLocation, useNavigate, type HistoryState } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  editDraft,
  followStoredSource,
  isNotFound,
  markDraftSaved,
  queryKeys,
  readValidationIssues,
  type HerculeClient,
  type Live,
  type LocatedIssue,
  type WorkflowCheckState,
  type WorkflowDraft,
} from "@hercule/client-core";
import { STARTER_WORKFLOW_SOURCE, type Workflow } from "@hercule/contract";
import { Button, cn } from "@hercule/ui";
import {
  agentsQuery,
  eventKindsQuery,
  workflowActionsQuery,
  workflowQuery,
} from "../../../app/queries";
import { readErrorMessage } from "../../../screens/save-status";
import { WorkflowEditor, type WorkflowEditorHandle } from "../../../screens/workflow-editor";
import { HeaderQuestion, WorkflowHeader } from "./-header";
import { ProblemsPanel } from "./-problems";
import type { WorkflowView } from "./-view";

/** What the header says beside Save, and in which hue. */
interface PageStatus {
  readonly text: string;
  readonly tone: "muted" | "attn" | "fail";
}

const STATUS_TONE: Readonly<Record<PageStatus["tone"], string>> = {
  muted: "text-muted",
  attn: "text-attn",
  fail: "text-fail",
};

/**
 * What a create puts in the history entry of the page that it opens. The new
 * page reads it to say that the workflow was created, and to put the focus in
 * the text.
 */
const JUST_CREATED_STATE: HistoryState & { readonly isJustCreated: true } = {
  isJustCreated: true,
};

/** Whether a history entry is the page that a create opened. */
const isJustCreatedState = (state: object): boolean =>
  "isJustCreated" in state && state.isJustCreated === true;

/**
 * The page on which a workflow is written: its name, the view control and
 * its actions in one row, the editor, and the problems of the text under it.
 * A new workflow has no stored text, so it starts from the starter text and
 * has nothing to delete.
 *
 * The page holds the text as the author types it, and compares it with the
 * stored text to know if there are changes to save. While there are, leaving
 * the page asks first. A stored text that changes elsewhere replaces the
 * text on the page only while the author has not edited it; otherwise the
 * page says so beside Save. A workflow that is deleted elsewhere keeps its
 * text on the page, and Save creates a new workflow from it.
 */
export function WorkflowPage({
  client,
  live,
  stored,
  isGone,
  view,
  onViewChange,
}: {
  readonly client: HerculeClient;
  readonly live: Live;
  /** The workflow as it was stored when it was last read, or `undefined` for a new one. */
  readonly stored: Workflow | undefined;
  /** Whether the controller no longer has the stored workflow. */
  readonly isGone: boolean;
  readonly view: WorkflowView;
  readonly onViewChange: (view: WorkflowView) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isJustCreated = useLocation({ select: (location) => isJustCreatedState(location.state) });
  const catalog = {
    actions: useSuspenseQuery(workflowActionsQuery(client)).data,
    eventKinds: useSuspenseQuery(eventKindsQuery(client)).data,
    agents: useSuspenseQuery(agentsQuery(client)).data.items,
  };

  const storedSource = stored?.source ?? STARTER_WORKFLOW_SOURCE;
  const [heldDraft, setHeldDraft] = useState<WorkflowDraft>({
    text: storedSource,
    baseSource: storedSource,
    hasDiverged: false,
  });
  const draft = followStoredSource(heldDraft, storedSource);
  if (draft !== heldDraft) setHeldDraft(draft);
  const text = draft.text;
  const hasChanges = text !== storedSource;

  const [issues, setIssues] = useState<ReadonlyArray<LocatedIssue>>([]);
  const [checkState, setCheckState] = useState<WorkflowCheckState>({ status: "checking" });
  const [name, setName] = useState<string>();
  const [isAskingToDelete, setIsAskingToDelete] = useState(false);
  const editor = useRef<WorkflowEditorHandle>(null);
  // Set in the click handler, so that a second click that comes before the
  // page renders the pending save cannot start a second save.
  const isSaving = useRef(false);

  const remove = useMutation({
    mutationFn: (id: string) => client.workflow.delete({ params: { id } }),
    // The list is read again before it shows, so it never shows the
    // workflow that is gone.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows(), refetchType: "all" }),
  });

  // The page's own delete also makes the workflow gone before the delete
  // answers, and the page then leaves. Only a workflow that is gone while no
  // delete of the page's own has started was deleted elsewhere.
  const isDeletedElsewhere = isGone && remove.isIdle;
  /** The stored workflow while the controller has it, or `undefined` when a save creates one. */
  const existingWorkflow = isDeletedElsewhere ? undefined : stored;

  const save = useMutation({
    mutationFn: (source: string) =>
      existingWorkflow === undefined
        ? client.workflow.create({ payload: { source } })
        : client.workflow.update({ params: { id: existingWorkflow.id }, payload: { source } }),
    onSuccess: ({ workflow }) => {
      // The answer is the stored workflow, so its page reads nothing again.
      queryClient.setQueryData(workflowQuery(client, workflow.id).queryKey, workflow);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows() });
      // An update answers the page's own workflow, and the saved text is
      // then the base of the text on the page. A create moves to the page of
      // the new workflow.
      if (workflow.id === stored?.id) setHeldDraft((held) => markDraftSaved(held, workflow.source));
    },
    onError: (error, source) => {
      const refused = readValidationIssues(error);
      if (refused !== undefined) editor.current?.markSaveRefusal(source, refused);
      // The workflow was deleted elsewhere. It is read again, so that the
      // page says so.
      if (isNotFound(error) && stored !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workflow(stored.id) });
      }
    },
    onSettled: () => {
      isSaving.current = false;
    },
  });

  const saveText = () => {
    if (isSaving.current) return;
    isSaving.current = true;
    // The header says what the last action did, and a save is the last now.
    remove.reset();
    // A create from the page of a workflow that was deleted elsewhere takes
    // the place of that page in the history. Back then cannot return to a
    // page that offers to create the workflow again.
    const replacedWorkflowId = existingWorkflow === undefined ? stored?.id : undefined;
    save.mutate(text, {
      // A callback of one call runs only while the page is mounted, so an
      // author who left before the answer is not brought back.
      onSuccess: ({ workflow }) => {
        if (existingWorkflow !== undefined) return;
        void navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: workflow.id },
          // The view of the address now, which the author can change while
          // the create is in flight.
          search: true,
          state: JUST_CREATED_STATE,
          replace: replacedWorkflowId !== undefined,
          // The text is saved, so there is nothing to ask about on the way out.
          ignoreBlocker: true,
        }).then(() => {
          // Removed only once the page is gone, because the page reads it until then.
          if (replacedWorkflowId !== undefined) {
            queryClient.removeQueries({ queryKey: queryKeys.workflow(replacedWorkflowId) });
          }
        });
      },
    });
  };
  // A create moves to the new workflow's page, which starts from the stored
  // text. The text cannot change while the create is in flight, so that
  // move never drops text that the author typed.
  const isCreating = save.isPending && existingWorkflow === undefined;

  // A save of the text on the page stores it, so while one is in flight,
  // leaving loses nothing. A workflow deleted elsewhere has its text on this
  // page only, so leaving it asks also when the text has no changes.
  const isSavingText = save.isPending && save.variables === text;
  const shouldAskToLeave = (hasChanges || isDeletedElsewhere) && !isSavingText;
  // A change of view stays on the page, so only a change of page asks.
  const leaveBlocker = useBlocker({
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname,
    disabled: !shouldAskToLeave,
    withResolver: true,
  });
  // A save that lands while the question shows leaves nothing to ask about,
  // so the navigation that the question holds goes on.
  useEffect(() => {
    if (leaveBlocker.status === "blocked" && !shouldAskToLeave) leaveBlocker.proceed();
  }, [leaveBlocker, shouldAskToLeave]);
  // One question at a time: the question to leave closes the question to
  // delete, which does not come back after Stay.
  if (leaveBlocker.status === "blocked" && isAskingToDelete) setIsAskingToDelete(false);

  // A check that could not run, as when the controller could not be
  // reached, runs again when the live connection comes back.
  useEffect(
    () =>
      live.onStatus((status) => {
        if (status === "connected") editor.current?.checkAgain();
      }),
    [live],
  );

  // After a create, the author goes on writing on the new page, so the focus
  // goes to the start of the text. The graph view shows no text to focus.
  const focusTextAfterCreate = useEffectEvent(() => {
    if (isJustCreated && view !== "graph") editor.current?.moveCursorToLine(1);
  });
  useEffect(() => {
    focusTextAfterCreate();
  }, []);

  const moveCursorToIssue = (issue: LocatedIssue) => {
    // The editor moves the cursor once the text shows, after the view changes.
    if (view === "graph") onViewChange("split");
    editor.current?.moveCursorToLine(issue.line);
  };

  /** What the header says beside Save: the first of these that is true now. */
  const decideStatus = (): PageStatus | undefined => {
    if (remove.error !== null) {
      return { text: `Not deleted: ${readErrorMessage(remove.error)}`, tone: "fail" };
    }
    // What the last save said is about the text that it sent, so it shows
    // only while that text is the text on the page. A save that found the
    // workflow gone is said by the notice below.
    const isSaveAboutText = save.variables === text;
    if (save.isError && isSaveAboutText && !isNotFound(save.error)) {
      return readValidationIssues(save.error) === undefined
        ? { text: `Not saved: ${readErrorMessage(save.error)}`, tone: "fail" }
        : { text: "Not saved: the text has problems.", tone: "fail" };
    }
    // A save creates a workflow with a new id, and a new workflow is off.
    if (isDeletedElsewhere) {
      return {
        text: "Deleted elsewhere. Saving creates a new workflow, turned off.",
        tone: "attn",
      };
    }
    // While a save is in flight, the page cannot tell its own change from a
    // change made elsewhere.
    if (draft.baseSource !== storedSource && !save.isPending) {
      return { text: "Changed elsewhere. Saving replaces that change.", tone: "attn" };
    }
    if (save.isSuccess && isSaveAboutText) return { text: "Saved.", tone: "muted" };
    // The page of a new workflow says what the create did until the author
    // changes the text or the workflow is turned on.
    if (isJustCreated && save.isIdle && !hasChanges && stored?.enabled === false) {
      return { text: "Created, turned off.", tone: "muted" };
    }
    return undefined;
  };
  const status = decideStatus();

  const question =
    leaveBlocker.status === "blocked" ? (
      <HeaderQuestion
        key="leave"
        question="Leave without saving?"
        declineLabel="Stay"
        acceptLabel="Leave"
        onDecline={leaveBlocker.reset}
        onAccept={leaveBlocker.proceed}
      />
    ) : isAskingToDelete && existingWorkflow !== undefined ? (
      <HeaderQuestion
        key="delete"
        question="Delete this workflow?"
        declineLabel="Cancel"
        acceptLabel="Confirm"
        onDecline={() => {
          setIsAskingToDelete(false);
        }}
        onAccept={() => {
          setIsAskingToDelete(false);
          remove.mutate(existingWorkflow.id, {
            // A callback of one call runs only while the page is mounted, so
            // an author who left before the answer is not brought back.
            onSuccess: (_, id) => {
              void navigate({ to: "/workflows", ignoreBlocker: true }).then(() => {
                // Removed only once the page is gone, because the page reads it until then.
                queryClient.removeQueries({ queryKey: queryKeys.workflow(id) });
              });
            },
          });
        }}
      />
    ) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkflowHeader
        // A text that has never read as a workflow names none, as a stored
        // text that a later version of the contract refuses.
        name={name ?? (stored === undefined ? "New workflow" : "Workflow")}
        view={view}
        onViewChange={onViewChange}
      >
        {question}
        {/* Hidden and not removed while a question shows, so the focus can
            go back to the button that asked. */}
        <div hidden={question !== undefined} className="flex min-w-0 items-center gap-1.5">
          {status === undefined ? null : (
            <span
              role={status.tone === "fail" ? "alert" : "status"}
              title={status.text}
              className={cn("min-w-0 truncate text-fine", STATUS_TONE[status.tone])}
            >
              {status.text}
            </span>
          )}
          {existingWorkflow === undefined ? null : (
            <Button
              disabled={remove.isPending}
              onClick={() => {
                remove.reset();
                setIsAskingToDelete(true);
              }}
            >
              Delete
            </Button>
          )}
          {/* `aria-disabled`, and not `disabled`, so that Save keeps the
              focus while its write is in flight and after it lands. While
              the page's own delete is in flight, a save would race it. */}
          <Button
            variant="form"
            aria-disabled={
              save.isPending || remove.isPending || (existingWorkflow !== undefined && !hasChanges)
            }
            onClick={saveText}
          >
            Save
          </Button>
        </div>
      </WorkflowHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-8 pt-4 pb-6">
        {/* The editor is laid over the room that is left, so a long text
            scrolls inside the editor and the page is never taller than the
            window. */}
        <div className="relative min-h-0 flex-1" inert={isCreating}>
          <div className="absolute inset-0">
            <WorkflowEditor
              ref={editor}
              source={text}
              onSourceChange={(next) => {
                setHeldDraft((held) => editDraft(held, next));
              }}
              view={view}
              catalog={catalog}
              validate={(source) => client.workflow.validate({ payload: { source } })}
              onIssuesChange={setIssues}
              onCheckStateChange={setCheckState}
              onNameChange={setName}
            />
          </div>
        </div>
        <ProblemsPanel issues={issues} checkState={checkState} onIssueClick={moveCursorToIssue} />
      </div>
    </div>
  );
}
