import { useRef, useSyncExternalStore, type FocusEvent, type JSX, type Ref } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  applyPick,
  buildComposerFields,
  buildComposerPlaceholder,
  buildOptionsLabel,
  buildPendingModelNote,
  buildSubmission,
  buildThreadWorkspaceLabel,
  computeEffectiveConfig,
  findResumeBlockedReason,
  formatAccessMode,
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
import {
  BranchIcon,
  LaptopIcon,
  MicIcon,
  PlusIcon,
  SendIcon,
  ShieldIcon,
  SlidersIcon,
  StopIcon,
  WorkspaceIcon,
} from "../../icons";
import { ComposerMenu } from "./composer-menu";
import { RequestDock } from "./dock";
import { ModelMenu } from "./model-menu";
import { OptionsMenu } from "./options-menu";
import { ProviderLogo } from "./provider-logo";
import { QueuedInputs } from "./queued-inputs";
import "./composer.css";

/** What one send carried: the request, and the picks it was built from. */
interface SentSubmission {
  readonly payload: SessionInputPayload;
  readonly picks: ThreadPicks;
  /** The account the thread runs on, which a picked model is remembered with. */
  readonly instanceId: string | null;
}

/**
 * Checks that focus on `element` keeps the composer expanded: it is inside
 * `composer`, and not on `dock-mini`, whose answers act without expanding
 * the composer.
 */
const keepsComposerExpanded = (composer: Element, element: EventTarget | null): boolean =>
  element instanceof Element &&
  composer.contains(element) &&
  element.closest(".dock-mini") === null;

/**
 * Renders the thread's composer, floating over the bottom of the transcript,
 * as the Bureau book's `.composer-wrap` draws it. From top to bottom:
 *
 * - the queued inputs, see `QueuedInputs`;
 * - the dock, while the session waits on a Request, see `RequestDock`;
 * - the card: the message field, then a row with Attach, the access mode,
 *   the model options when the model has any, the model, Dictate, and Send,
 *   or Stop while a turn runs;
 * - the lip under the card: where the thread works, and on which machine.
 *
 * ⏎ in the field sends the message and ⇧⏎ starts a new line. The controller
 * opens a turn with a message sent to an idle thread, and queues one sent
 * while a turn runs. Stop interrupts the running turn. A thread that has
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
 *   line high, with only the field and the Request's one-line `dock-mini`
 *   left. The thread screen decides it.
 * - `onFocusChange` is told whether the focus is in the composer, which
 *   keeps the composer expanded. Focus on `dock-mini` does not count.
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
  // Set when a send starts and cleared when it settles. `isPending` reaches
  // the render only after `mutate`, so a second ⏎ in between would still
  // see it false; the ref is set at once.
  const sendingRef = useRef(false);
  // Whether the pointer went down on the shrunk composer, anywhere but on
  // `dock-mini`'s answers. By the time the click arrives, the focus it moved
  // has already expanded the composer.
  const expandOnClickRef = useRef(false);

  // No runner is local to the desktop app. A started thread names its own
  // runner, which is the one every field reads.
  const catalogs: ThreadCatalogs = {
    instances,
    runners,
    localRunnerId: null,
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
    mutationFn: (sent: SentSubmission) =>
      client.session.input({ params: { id: sessionId }, payload: sent.payload }),
    // Registered here rather than passed to `mutate`, so it also runs when
    // the user has left the thread before the send returns.
    onSuccess: async (_session, sent) => {
      // The picks are cleared only once the session with the new model is in
      // the cache, so the pill never shows the old model in between.
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
      // What was typed or picked while the message was on its way belongs to
      // the next message, so only what was sent is cleared.
      const now = pendingSubmissions.read(sessionId);
      pendingSubmissions.write(sessionId, {
        message: now.message.text === sent.payload.text ? { text: "" } : now.message,
        picks: now.picks === sent.picks ? {} : now.picks,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sessionId) });
      // Recent holds the models the user picked, never a default.
      if (sent.payload.model !== undefined && sent.instanceId !== null) {
        rememberRecentModel(controller.url, {
          instanceId: sent.instanceId,
          model: sent.payload.model,
        });
      }
    },
    onSettled: () => {
      sendingRef.current = false;
    },
  });
  const interrupt = useMutation({
    mutationFn: () => client.session.interrupt({ params: { id: sessionId } }),
    // The response is not written into the cache. It is the session as the
    // controller read it before the interrupt, still busy, so writing it
    // could bring back a Stop the live `session` push has already cleared.
  });
  const error = input.error ?? interrupt.error;
  const canSend = readOnly === null && pending.message.text.trim() !== "" && !input.isPending;

  const writeText = (text: string): void => {
    pendingSubmissions.write(sessionId, {
      ...pendingSubmissions.read(sessionId),
      message: { text },
    });
  };
  // Each pick is compared with the thread's own configuration, not with the
  // picks before it, so picking the configured value again removes the pick.
  const pick = (step: ComposerPick): void => {
    const now = pendingSubmissions.read(sessionId);
    pendingSubmissions.write(sessionId, {
      ...now,
      picks: applyPick(catalogs, base, now.picks, step),
    });
  };
  const submit = (): void => {
    if (!canSend || sendingRef.current) return;
    const submission = buildSubmission(thread, pending.picks, pending.message);
    // A thread that has started always takes an input rather than a spawn.
    if (submission.kind !== "input") return;
    sendingRef.current = true;
    if (interrupt.isError) interrupt.reset();
    input.mutate({
      payload: submission.payload,
      picks: pending.picks,
      instanceId: config.instanceId,
    });
    scrollTranscriptToBottom();
  };
  const stop = (): void => {
    if (interrupt.isPending) return;
    if (input.isError) input.reset();
    interrupt.mutate();
  };

  const reportFocus = (event: FocusEvent<HTMLDivElement>, element: EventTarget | null): void => {
    onFocusChange(keepsComposerExpanded(event.currentTarget, element));
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
          expandOnClickRef.current =
            shrunk &&
            !(event.target instanceof Element && event.target.closest(".dock-mini button"));
        }}
        onClick={() => {
          if (!expandOnClickRef.current) return;
          expandOnClickRef.current = false;
          fieldRef.current?.focus();
          scrollTranscriptToBottom();
        }}
      >
        <div className="fold">
          <QueuedInputs sessionId={sessionId} />
        </div>
        {session.openRequest === null ? null : (
          <RequestDock
            key={session.openRequest.requestId}
            sessionId={sessionId}
            request={session.openRequest}
          />
        )}
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
              writeText(event.target.value);
            }}
            onKeyDown={(event) => {
              // ⏎ sends and ⇧⏎ starts a new line. The ⏎ that ends an IME
              // composition does not send, or it would cut a Japanese or
              // Chinese sentence off mid-word. Chromium marks that ⏎ with
              // `isComposing`, and some input methods with the legacy
              // `keyCode` 229, "the IME handled this key".
              if (event.key !== "Enter" || event.shiftKey) return;
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
                <ComposerMenu
                  label="Model options"
                  align="start"
                  disabled={readOnly !== null}
                  triggerClassName="pick"
                  trigger={
                    <>
                      <SlidersIcon size={14} />
                      {buildOptionsLabel(descriptors, config.options) ?? "Model options"}
                    </>
                  }
                >
                  {() => (
                    <OptionsMenu
                      descriptors={descriptors}
                      selected={config.options}
                      modelName={pill.name}
                      onPick={(id, value) => {
                        pick({ kind: "option", id, value });
                      }}
                    />
                  )}
                </ComposerMenu>
              )}
              {/* The note fills the spacer, so no control moves when it shows. */}
              <span className="spacer composer-note">{note}</span>
              <ComposerMenu
                label="Model"
                align="end"
                wide
                disabled={readOnly !== null}
                triggerClassName="pick pick--pill"
                trigger={
                  <>
                    {pill.providerId === null ? null : (
                      <ProviderLogo providerId={pill.providerId} size={13} />
                    )}
                    {pill.account === null ? null : <span className="faint">{pill.account}</span>}
                    <span className="pick-name">{pill.name ?? "No model"}</span>
                  </>
                }
              >
                {(close) => (
                  <ModelMenu
                    catalogs={catalogs}
                    config={config}
                    recent={readRecentModels(controller.url)}
                    onPick={(model) => {
                      pick({ kind: "model", value: model });
                      close();
                    }}
                  />
                )}
              </ComposerMenu>
              <button type="button" className="icon-btn" title="Dictate" aria-disabled="true">
                <MicIcon />
              </button>
              {busy ? (
                <button
                  type="button"
                  className="stop"
                  title="Stop"
                  aria-disabled={interrupt.isPending || undefined}
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
                {readErrorMessage(error)}
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
                    <span className="mono">{piece.text}</span>
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
