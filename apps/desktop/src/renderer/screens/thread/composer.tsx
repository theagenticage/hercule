import { useSyncExternalStore, type JSX, type Ref } from "react";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  applyThreadChoice,
  buildComposerFields,
  buildComposerPlaceholder,
  buildPendingModelNote,
  buildRecentModel,
  buildSubmission,
  buildThreadWorkspaceLabel,
  findExpiredShelfKeys,
  findResumeBlockedReason,
  holdsMessageContent,
  formatAccessMode,
  isMutationRunning,
  locateShownRequest,
  markShelfItemsExpired,
  queryKeys,
  readErrorMessage,
  resolveThreadConfig,
  type RecentModel,
  type ShelfItem,
  type ThreadCatalogs,
  type ThreadChoice,
  type ThreadPicks,
} from "@hercule/client-core";
import type { SessionInputPayload } from "@hercule/contract";
import {
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionQuery,
  readSkillsIfStale,
  sessionSkillsQuery,
  threadsQuery,
  workspacesQuery,
} from "../../app/queries";
import { readRecentModels, rememberRecentModel } from "../../app/recent-models";
import { useShownRequestId } from "../../app/request-drafts";
import { BranchIcon } from "../../icons/branch";
import { LaptopIcon } from "../../icons/laptop";
import { ShieldIcon } from "../../icons/shield";
import { WorkspaceIcon } from "../../icons/workspace";
import { useComposerImages } from "../attachments/use-composer-images";
import { ComposerFrame } from "../session/composer-frame";
import { useSendOnMenuCommand } from "../session/send-key";
import { MESSAGE_HISTORY_KEY, useComposerAnswer } from "../session/use-composer-answer";
import { useTypingGuard } from "../session/use-typing-guard";
import { TallyPill } from "../subagents/tally-pill";
import { useStopAgent } from "../use-stop-agent";
import { AgentRequestDock } from "./agent-request-dock";
import { ModelPick, OptionsPick } from "./composer-picks";
import { QueuedInputs } from "./queued-inputs";
import { WorkspaceDetailsTrigger } from "../workspace/details-trigger";

/** What one send carried: the request, and the images and picks it was built from. */
interface SentSubmission {
  readonly payload: SessionInputPayload;
  readonly attachments: readonly ShelfItem[];
  /**
   * The picks the request was built from. They are compared by reference with
   * the picks held when the send returns, so picks made meanwhile are kept.
   */
  readonly picks: ThreadPicks;
  /** The model this send picked, to remember in Recent once it succeeds, or `null` when it picked none. */
  readonly recent: RecentModel | null;
}

/**
 * Renders the thread's composer in a `ComposerFrame`, floating over the
 * bottom of the transcript. From top to bottom:
 *
 * - the tally pill, while the thread has subagents, see `TallyPill`;
 * - the queued inputs, see `QueuedInputs`;
 * - the dock, while the session waits on a Request, with the pager line
 *   above it when there is one, see `AgentRequestDock`;
 * - the card: the shelf of attached images, the message field, then a row
 *   with Attach, the access mode,
 *   the model options when the model has any, the model, Dictate, and Send,
 *   or Stop while a turn runs;
 * - the lip under the card: where the thread works, and on which machine.
 *
 * While the dock shows a question the agent asked, the composer answers it
 * instead (`useComposerAnswer`): the field shows and edits the shown
 * question's own answer, and Send gives way to Previous and the step button,
 * with Stop beside them while a turn runs. The field then takes text only, no
 * images and no skills. The Message Draft below is kept as it is and comes
 * back when the Request closes, or when the dock shows another Request. A
 * question does not take over while the user is typing a message: it waits
 * until they pause, send, or leave the field (`useTypingGuard`).
 *
 * ⏎ in the field sends the message and ⇧⏎ starts a new line. The controller
 * opens a turn with a message sent to an idle thread, and queues one sent
 * while a turn runs. Stop stops everything the session runs: its own
 * agent's turn and every running subagent (`useStopAgent`). A thread that has
 * exited and cannot be resumed takes no message: its field is read-only
 * and its menus do not open.
 *
 * The model and its options can change on a thread that has started, within
 * the account it started on. A pick applies to the next message, which
 * carries it, and a note in the row says so until then. The access mode,
 * the workspace and the machine are fixed once the thread starts, so they
 * are plain text, with the reason as their tooltip.
 *
 * Images come in by paste, drop and Attach, see `useComposerImages`. A
 * message can be images alone. Send waits while an upload runs, has failed
 * or has expired, and while the model takes no images; the notice under the
 * field says which.
 *
 * `$` in the field lists the thread's skills and `/` its commands (see
 * `MessageField`). The skills are read when the composer mounts, unless the
 * thread takes no input, and again when a list opens and they are more than
 * a few seconds old.
 *
 * What the composer holds and has not sent, the text, the images and the picks, is kept
 * per thread in the controller's `pendingSubmissions` rather than here, so
 * it is still there when the user comes back to the thread.
 *
 * `shrunk`, `onFocusChange`, `scrollTranscriptToBottom` and `ref` are the
 * frame's: see `ComposerFrame`. The thread screen decides `shrunk`.
 * `scrollTranscriptToBottom` is also called when a message is sent.
 */
export function ThreadComposer({
  sessionId,
  shrunk,
  onFocusChange,
  scrollTranscriptToBottom,
  ref,
}: {
  readonly sessionId: string;
  readonly shrunk: boolean;
  readonly onFocusChange: (focused: boolean) => void;
  readonly scrollTranscriptToBottom: () => void;
  readonly ref?: Ref<HTMLDivElement>;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client, pendingSubmissions } = controller;
  const queryClient = useQueryClient();
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const resources = useSuspenseQuery(resourcesQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  const [shownRequestId] = useShownRequestId(sessionId);
  const pending = useSyncExternalStore(pendingSubmissions.subscribe, () =>
    pendingSubmissions.read(sessionId),
  );
  // The send is keyed by the thread, so a composer mounted again while its
  // send is still on the way, after the user left and came back, finds it
  // running and does not send the message twice.
  const sendKey = ["thread-input", sessionId];
  const sending = useIsMutating({ mutationKey: sendKey }) > 0;

  // No runner is local to the desktop app. A started thread names its own
  // runner, which is the one every field reads.
  const catalogs: ThreadCatalogs = {
    instances,
    runners,
    thisMacRunnerId: null,
    projects,
    resources,
    workspaces,
    sessions: threads,
  };
  const thread = { kind: "active", session } as const;
  const resolved = resolveThreadConfig(catalogs, thread, pending.picks);
  const { config } = resolved;
  const fields = buildComposerFields(catalogs, resolved);
  const readOnly = findResumeBlockedReason(session);
  const busy = session.status === "busy";
  const workspaceLabel = buildThreadWorkspaceLabel(session, workspaces);
  const placeholder = buildComposerPlaceholder({
    readOnly,
    busy,
    active: true,
    pick: fields.workspace.value,
    workspaces,
  });
  const { pill } = fields.model;
  const descriptors = fields.options;
  const note = buildPendingModelNote(resolved);

  const input = useMutation({
    mutationKey: sendKey,
    mutationFn: (sent: SentSubmission) =>
      client.session.input({ params: { id: sessionId }, payload: sent.payload }),
    // Registered here rather than passed to `mutate`, so it also runs when
    // the user has left the thread before the send returns.
    onSuccess: async (_session, sent) => {
      // The picks are cleared only once the session with the new model is in
      // the cache, so the pill never shows the old model in between.
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
      pendingSubmissions.clearSent(sessionId, {
        text: sent.payload.text,
        attachments: sent.attachments,
        picks: sent.picks,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sessionId) });
      if (sent.recent !== null) rememberRecentModel(controller.url, sent.recent);
    },
    // Kept in the pending submission rather than read from `input.error`: a
    // composer mounted again, after the user left and came back, has a
    // mutation of its own, which never saw this send fail.
    onError: (error, sent) => {
      pendingSubmissions.recordFailure(sessionId, readErrorMessage(error));
      // An image the controller swept before the send is marked on its tile,
      // so the user sees which one to attach again.
      const expired = findExpiredShelfKeys(error, sent.attachments);
      if (expired.length > 0)
        pendingSubmissions.updateAttachments(sessionId, (shelf) =>
          markShelfItemsExpired(shelf, expired),
        );
    },
  });
  const stopAgent = useStopAgent(client, sessionId);
  const guard = useTypingGuard();
  // The Request the dock shows, which `AgentRequestDock` decides the same way.
  const shownRequest =
    locateShownRequest(session.openRequests, (request) => request.requestId, shownRequestId)
      ?.request ?? null;
  const answer = useComposerAnswer(sessionId, shownRequest, guard.holding);
  const stopFailure = stopAgent.error === null ? null : readErrorMessage(stopAgent.error);
  const error =
    answer === null ? (pending.failure ?? stopFailure) : (answer.failure ?? stopFailure);
  const images = useComposerImages({
    storeKey: sessionId,
    shelf: pending.message.attachments,
    imageInput: fields.model.imageInput,
    modelName: fields.model.modelName,
    readOnly: readOnly !== null,
  });
  // Not suspense: skills are an addition to the composer. A thread that has
  // exited takes no message, so it has no use for them.
  const sessionSkills = useQuery({
    ...sessionSkillsQuery(client, sessionId),
    enabled: readOnly === null,
  });
  const canSend =
    readOnly === null && !sending && !images.sendBlocked && holdsMessageContent(pending.message);

  const recordThreadChoice = (choice: ThreadChoice): void => {
    const { picks } = pendingSubmissions.read(sessionId);
    pendingSubmissions.writePicks(sessionId, applyThreadChoice(picks, choice));
  };
  const submit = (): void => {
    // The user is done typing, whether or not the send goes through.
    guard.release();
    if (!canSend || isMutationRunning(queryClient, sendKey)) return;
    const submission = buildSubmission(resolved, pending.message);
    pendingSubmissions.clearFailure(sessionId);
    if (stopAgent.error !== null) stopAgent.reset();
    images.clearRefusal();
    input.mutate({
      payload: submission.payload,
      attachments: pending.message.attachments,
      picks: pending.picks,
      recent: buildRecentModel(pending.picks, resolved),
    });
    scrollTranscriptToBottom();
  };
  const sendOrStep = answer === null ? submit : answer.step.onStep;
  useSendOnMenuCommand(sendOrStep);
  const stop = (): void => {
    // `useStopAgent` already ignores a second stop, but Stop is only
    // `aria-disabled` while one is in flight, so it can still be clicked:
    // such a click must not clear the send failure either.
    if (stopAgent.isPending) return;
    pendingSubmissions.clearFailure(sessionId);
    stopAgent.stop();
  };

  return (
    <ComposerFrame
      text={answer?.text ?? pending.message.text}
      onTextChange={
        answer?.onTextChange ??
        ((text) => {
          guard.holdAfterEdit();
          pendingSubmissions.writeText(sessionId, text);
        })
      }
      placeholder={answer?.placeholder ?? placeholder}
      readOnly={readOnly !== null || answer?.locked === true}
      canSend={canSend}
      onSend={sendOrStep}
      stop={busy ? { stopping: stopAgent.isPending, onStop: stop } : undefined}
      error={error}
      notice={answer === null ? images.notice : answer.notice}
      attachments={answer?.attachments ?? images.attachments}
      skills={
        answer === null
          ? {
              skills: sessionSkills.data?.items,
              failure:
                sessionSkills.error === null ? undefined : readErrorMessage(sessionSkills.error),
              refreshIfStale: () => {
                readSkillsIfStale(queryClient, sessionSkillsQuery(client, sessionId));
              },
            }
          : undefined
      }
      step={answer?.step}
      historyKey={answer?.historyKey ?? MESSAGE_HISTORY_KEY}
      onFieldBlur={guard.release}
      // Only a composition in the Message Draft holds off a question. While
      // answering, the hold would make the composer show the Message Draft
      // instead of the answer being composed.
      onComposingChange={answer === null ? guard.reportComposing : undefined}
      start={
        <>
          <span className="pick" title={fields.accessMode.locked ?? undefined}>
            <ShieldIcon size={14} />
            {formatAccessMode(fields.accessMode.value)}
          </span>
          {descriptors === null ? null : (
            <OptionsPick
              descriptors={descriptors}
              selected={config.options}
              modelName={pill.name}
              disabled={readOnly !== null}
              onChoose={recordThreadChoice}
            />
          )}
        </>
      }
      note={note}
      end={
        <ModelPick
          pill={pill}
          catalogs={catalogs}
          config={config}
          kind="active"
          disabled={readOnly !== null}
          readRecent={() => readRecentModels(controller.url)}
          onChoose={recordThreadChoice}
        />
      }
      above={
        <>
          <div className="fold tally-fold">
            <TallyPill sessionId={sessionId} />
          </div>
          <div className="fold">
            <QueuedInputs sessionId={sessionId} />
          </div>
          <AgentRequestDock sessionId={sessionId} pageSubagentId={undefined} composerBelow />
        </>
      }
      below={
        <div className="fold">
          <div className="lip">
            {workspaceLabel.map((piece, index) => {
              // A label holds at most one piece of each kind.
              const content = (
                <>
                  {piece.kind === "branch" ? (
                    <>
                      <BranchIcon size={13} />
                      <span>{piece.text}</span>
                      {piece.startedFrom === null ? null : (
                        <>
                          {" "}
                          <span className="faint">{piece.startedFrom}</span>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <WorkspaceIcon size={13} />
                      {piece.text}
                    </>
                  )}
                </>
              );
              return index === 0 && session.workspaceId !== null ? (
                <span key={index}>
                  <WorkspaceDetailsTrigger workspaceId={session.workspaceId}>
                    {content}
                  </WorkspaceDetailsTrigger>
                </span>
              ) : (
                <span key={index} title={fields.workspace.locked ?? undefined}>
                  {content}
                </span>
              );
            })}
            <span className="spacer" />
            <span title={fields.machine.locked ?? undefined}>
              <LaptopIcon size={13} />
              {fields.machine.label}
            </span>
          </div>
        </div>
      }
      shrunk={shrunk}
      onFocusChange={onFocusChange}
      scrollMessagesToBottom={scrollTranscriptToBottom}
      ref={ref}
    />
  );
}
