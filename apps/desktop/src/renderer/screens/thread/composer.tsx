import { useRef, useSyncExternalStore, type FocusEvent, type JSX, type Ref } from "react";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  applyPicks,
  buildComposerFields,
  buildComposerPlaceholder,
  buildPendingModelNote,
  buildRecentModel,
  buildSubmission,
  buildThreadWorkspaceLabel,
  computeEffectiveConfig,
  findResumeBlockedReason,
  formatAccessMode,
  isMutationRunning,
  queryKeys,
  readErrorMessage,
  readThreadConfig,
  type ComposerPick,
  type ThreadCatalogs,
  type ThreadPicks,
} from "@hercule/client-core";
import type { SessionInputPayload } from "@hercule/contract";
import {
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionQuery,
  threadsQuery,
  workspacesQuery,
} from "../../app/queries";
import { readRecentModels, rememberRecentModel } from "../../app/recent-models";
import { BranchIcon } from "../../icons/branch";
import { LaptopIcon } from "../../icons/laptop";
import { MicIcon } from "../../icons/mic";
import { PlusIcon } from "../../icons/plus";
import { SendIcon } from "../../icons/send";
import { ShieldIcon } from "../../icons/shield";
import { StopIcon } from "../../icons/stop";
import { WorkspaceIcon } from "../../icons/workspace";
import { TallyPill } from "../subagents/tally-pill";
import { useStopAgent } from "../use-stop-agent";
import { AgentRequestDock, REQUEST_PAGER_CLASS } from "./agent-request-dock";
import { ModelPick, OptionsPick } from "./composer-picks";
import { QueuedInputs } from "./queued-inputs";
import { isSendKey, useSendOnMenuCommand } from "./send-key";
import "./composer.css";

/** What one send carried: the request, and the picks it was built from. */
interface SentSubmission {
  readonly payload: SessionInputPayload;
  readonly picks: ThreadPicks;
  /** The account the thread runs on, which a picked model is remembered with. */
  readonly instanceId: string | null;
}

/**
 * Checks that `element` is on one of the two lines the shrunk composer keeps
 * of a Request: `dock-mini` or the Request pager line.
 */
const isOnRequestLines = (element: Element): boolean =>
  element.closest(`.dock-mini, .${REQUEST_PAGER_CLASS}`) !== null;

/**
 * Checks that a click on `target` leaves the shrunk composer shrunk: it is
 * on one of `dock-mini`'s answers, or anywhere on the Request pager line. A
 * click on the rest of `dock-mini`, such as its question, expands the
 * composer like a click anywhere else.
 */
const keepsComposerShrunk = (target: EventTarget): boolean =>
  target instanceof Element &&
  target.closest(`.dock-mini button, .${REQUEST_PAGER_CLASS}`) !== null;

/**
 * Renders the thread's composer, floating over the bottom of the transcript,
 * as the Bureau book's `.composer-wrap` draws it. From top to bottom:
 *
 * - the tally pill, while the thread has subagents, see `TallyPill`;
 * - the queued inputs, see `QueuedInputs`;
 * - the dock, while the session waits on a Request, with the pager line
 *   above it when there is one, see `AgentRequestDock`;
 * - the card: the message field, then a row with Attach, the access mode,
 *   the model options when the model has any, the model, Dictate, and Send,
 *   or Stop while a turn runs;
 * - the lip under the card: where the thread works, and on which machine.
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
 * What the composer holds and has not sent, the text and the picks, is kept
 * per thread in the controller's `pendingSubmissions` rather than here, so
 * it is still there when the user comes back to the thread.
 *
 * Attach and Dictate are drawn but do nothing yet, and carry
 * `aria-disabled`.
 *
 * - `shrunk` draws the composer as the book's `.is-scrolled`: narrower, one
 *   line high, with only the field, the Request's pager line and its
 *   one-line `dock-mini` left. The thread screen decides it.
 * - `onFocusChange` is called with whether the focus is in the composer,
 *   which keeps the composer expanded. Focus on `dock-mini` or the pager line
 *   keeps the size the composer has.
 * - `scrollTranscriptToBottom` is called when a message is sent, and when a
 *   click on the shrunk composer expands it.
 * - `ref` receives the stack of the rows above, the card and the lip, whose
 *   height is what the composer covers of the transcript, less the 18px the
 *   stack sits above the pane's bottom edge.
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
  const pending = useSyncExternalStore(pendingSubmissions.subscribe, () =>
    pendingSubmissions.read(sessionId),
  );
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // The send is keyed by the thread, so a composer mounted again while its
  // send is still on the way, after the user left and came back, finds it
  // running and does not send the message twice.
  const sendKey = ["thread-input", sessionId];
  const sending = useIsMutating({ mutationKey: sendKey }) > 0;
  // Whether the pointer went down on the shrunk composer, anywhere but on
  // `dock-mini`'s answers or the pager line. By the time the click arrives,
  // the focus it moved has already expanded the composer.
  const expandOnClickRef = useRef(false);

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
  const base = readThreadConfig(thread);
  const config = computeEffectiveConfig(base, pending.picks);
  const fields = buildComposerFields(catalogs, config, "active");
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
  const note = buildPendingModelNote("active", pending.picks);

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
      pendingSubmissions.clearSent(sessionId, { text: sent.payload.text, picks: sent.picks });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sessionId) });
      const recent = buildRecentModel(sent.picks, sent.instanceId);
      if (recent !== null) rememberRecentModel(controller.url, recent);
    },
    // Kept in the pending submission rather than read from `input.error`: a
    // composer mounted again, after the user left and came back, has a
    // mutation of its own, which never saw this send fail.
    onError: (error) => {
      pendingSubmissions.recordFailure(sessionId, readErrorMessage(error));
    },
  });
  const stopAgent = useStopAgent(client, sessionId);
  const error =
    pending.failure ?? (stopAgent.error === null ? null : readErrorMessage(stopAgent.error));
  const canSend = readOnly === null && pending.message.text.trim() !== "" && !sending;

  // Each pick is compared with the thread's own configuration, not with the
  // picks before it, so picking the configured value again removes the pick.
  const pick = (steps: readonly ComposerPick[]): void => {
    const { picks } = pendingSubmissions.read(sessionId);
    pendingSubmissions.writePicks(sessionId, applyPicks(catalogs, base, picks, steps));
  };
  const submit = (): void => {
    if (!canSend || isMutationRunning(queryClient, sendKey)) return;
    const submission = buildSubmission(thread, pending.picks, pending.message);
    pendingSubmissions.clearFailure(sessionId);
    if (stopAgent.error !== null) stopAgent.reset();
    input.mutate({
      payload: submission.payload,
      picks: pending.picks,
      instanceId: config.instanceId,
    });
    scrollTranscriptToBottom();
  };
  useSendOnMenuCommand(submit);
  const stop = (): void => {
    // `useStopAgent` already ignores a second stop, but Stop is only
    // `aria-disabled` while one is in flight, so it can still be clicked:
    // such a click must not clear the send failure either.
    if (stopAgent.isPending) return;
    pendingSubmissions.clearFailure(sessionId);
    stopAgent.stop();
  };

  // Focus inside the composer keeps it expanded. Focus on the Request lines
  // keeps the size the composer has instead, so a user who answers or pages a
  // Request from the shrunk composer keeps reading the transcript.
  const reportFocus = (event: FocusEvent<HTMLDivElement>, element: EventTarget | null): void => {
    onFocusChange(
      element instanceof Element &&
        event.currentTarget.contains(element) &&
        !(shrunk && isOnRequestLines(element)),
    );
  };

  return (
    <div className="composer-wrap">
      <div
        className={shrunk ? "composer is-scrolled" : "composer"}
        ref={ref}
        onFocus={(event) => {
          reportFocus(event, event.target);
        }}
        onBlur={(event) => {
          // The focused element also loses the focus when the window does,
          // and gets it back when the window returns. The composer keeps its
          // size in between.
          if (!document.hasFocus()) return;
          reportFocus(event, event.relatedTarget);
        }}
        onPointerDown={(event) => {
          expandOnClickRef.current = shrunk && !keepsComposerShrunk(event.target);
        }}
        onClick={() => {
          if (!expandOnClickRef.current) return;
          expandOnClickRef.current = false;
          fieldRef.current?.focus();
          scrollTranscriptToBottom();
        }}
      >
        <div className="fold tally-fold">
          <TallyPill sessionId={sessionId} />
        </div>
        <div className="fold">
          <QueuedInputs sessionId={sessionId} />
        </div>
        <AgentRequestDock sessionId={sessionId} pageSubagentId={undefined} />
        <div className="composer-card">
          <textarea
            ref={fieldRef}
            className="composer-input"
            rows={1}
            readOnly={readOnly !== null}
            aria-disabled={readOnly !== null || undefined}
            aria-label="Message"
            placeholder={placeholder}
            value={pending.message.text}
            onChange={(event) => {
              pendingSubmissions.writeText(sessionId, event.target.value);
            }}
            onKeyDown={(event) => {
              if (!isSendKey(event)) return;
              event.preventDefault();
              submit();
            }}
          />
          <div className="fold">
            <div className="composer-row">
              <button type="button" className="icon-btn" title="Attach" aria-disabled="true">
                <PlusIcon />
              </button>
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
                  onPick={pick}
                />
              )}
              {/* The note fills the spacer, so no control moves when it shows. */}
              <span className="spacer composer-note">{note}</span>
              <ModelPick
                pill={pill}
                catalogs={catalogs}
                config={config}
                kind="active"
                disabled={readOnly !== null}
                readRecent={() => readRecentModels(controller.url)}
                onPick={pick}
              />
              <button type="button" className="icon-btn" title="Dictate" aria-disabled="true">
                <MicIcon />
              </button>
              {busy ? (
                <button
                  type="button"
                  className="stop"
                  title="Stop"
                  aria-disabled={stopAgent.isPending || undefined}
                  onClick={stop}
                >
                  <StopIcon size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className={canSend ? "send" : "send send--off"}
                  title="Send"
                  aria-disabled={!canSend || undefined}
                  onClick={submit}
                >
                  <SendIcon />
                </button>
              )}
            </div>
            {error === null ? null : (
              <p className="composer-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="fold">
          <div className="lip">
            {workspaceLabel.map((piece) => (
              // A label holds at most one piece of each kind.
              <span key={piece.kind} title={fields.workspace.locked ?? undefined}>
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
              </span>
            ))}
            <span className="spacer" />
            <span title={fields.machine.locked ?? undefined}>
              <LaptopIcon size={13} />
              {fields.machine.label}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
