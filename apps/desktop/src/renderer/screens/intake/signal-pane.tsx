/**
 * Intake's pane: the open signal, top to bottom as spec 17 §The pane lists
 * it, with its answers and the keys at its foot.
 */
import { useEffect, useId, useImperativeHandle, useRef, useState, type JSX, type Ref } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Signal } from "@hercule/contract";
import {
  buildSignalAnswers,
  describeAnswerKey,
  describeBuildFailure,
  describeResolvedElsewhere,
  describeSignalAsker,
  describeSignalOutcome,
  describeSignalProvenance,
  findReplyAnswer,
  findSuggestedAnswer,
  formatMessageTime,
  nameSignalSource,
  queryKeys,
  readErrorMessage,
  readSignalPluginId,
  type PluginIdentity,
} from "@hercule/client-core";
import { eventQuery, signalQuery } from "../../app/queries";
import { CheckIcon } from "../../icons/check";
import { ExternalIcon } from "../../icons/external";
import { SignalAnswers, type AnswerFailure } from "./signal-answers";
import { SignalBlocks } from "./signal-blocks";
import { SourceMark } from "./source-mark";

/** What Intake's keys do in the pane, called by the screen's key handler. */
export interface SignalPaneHandle {
  /** Puts the focus on the suggested answer: its button, or a suggested reply's text box. */
  readonly focusSuggested: () => void;
  /** Opens the first Reply box and puts the focus in it. Does nothing when the signal has none. */
  readonly openReply: () => void;
  /** Opens the signal on its source, in the default browser. Does nothing when its address is not known. */
  readonly openOnSource: () => void;
}

/**
 * Renders the pane of the signal `signalId`. Until the controller answers
 * its read, the pane shows `listed`, the signal as the To do list holds it,
 * so it opens at once; the read adds the describe lines of its answers.
 *
 * `focusSuggestedOnOpen` puts the focus on the suggested answer as soon as
 * the pane shows the signal, then calls `onFocusedSuggested`. `ref` gives
 * the screen's keys the pane's moves.
 */
export function SignalPane({
  signalId,
  listed,
  plugins,
  timezone,
  focusSuggestedOnOpen,
  onFocusedSuggested,
  ref,
}: {
  readonly signalId: string;
  readonly listed: Signal | undefined;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly timezone: string;
  readonly focusSuggestedOnOpen: boolean;
  readonly onFocusedSuggested: () => void;
  readonly ref: Ref<SignalPaneHandle>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const read = useQuery({ ...signalQuery(client, signalId), placeholderData: () => listed });
  return (
    <section className="asks-detail" aria-label="The open signal">
      {read.data !== undefined ? (
        <SignalDetail
          key={signalId}
          signal={read.data}
          plugins={plugins}
          timezone={timezone}
          focusSuggestedOnOpen={focusSuggestedOnOpen}
          onFocusedSuggested={onFocusedSuggested}
          ref={ref}
        />
      ) : read.isError ? (
        <div className="ad">
          <p className="ad-flag" role="alert">
            {readErrorMessage(read.error)}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Renders a signal's pane once its record is at hand.
 *
 * The pane tells two endings apart. A signal the user answered here, or one
 * already resolved when the pane opened, shows its outcome. A signal that
 * was open when the pane opened and was resolved elsewhere while it showed,
 * on the source, from the CLI or from another client, says so, and keeps any
 * reply being typed.
 */
function SignalDetail({
  signal,
  plugins,
  timezone,
  focusSuggestedOnOpen,
  onFocusedSuggested,
  ref,
}: {
  readonly signal: Signal;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly timezone: string;
  readonly focusSuggestedOnOpen: boolean;
  readonly onFocusedSuggested: () => void;
  readonly ref: Ref<SignalPaneHandle>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const idPrefix = useId();
  const rootRef = useRef<HTMLElement>(null);
  const sourceLinkRef = useRef<HTMLAnchorElement>(null);
  const answers = buildSignalAnswers(signal);
  const suggested = findSuggestedAnswer(answers);
  const [openedOpen] = useState(signal.status === "open");
  const [actedHere, setActedHere] = useState(false);
  const [openReplyId, setOpenReplyId] = useState<string | null>(
    suggested?.style === "reply" ? suggested.action.id : null,
  );
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  // `useMutation` drops its error when the next answer starts, and the error
  // must name the answer it belongs to, so the failure is kept here.
  const [failure, setFailure] = useState<AnswerFailure | null>(null);

  const act = useMutation({
    mutationFn: (input: { readonly actionId: string; readonly text?: string }) =>
      client.signal.act({ params: { id: signal.id }, payload: input }),
    onMutate: () => {
      setFailure(null);
    },
    onSuccess: (acted) => {
      setActedHere(true);
      queryClient.setQueryData(signalQuery(client, signal.id).queryKey, acted);
      void queryClient.invalidateQueries({ queryKey: queryKeys.signals() });
    },
    onError: (error, input) => {
      setFailure({ actionId: input.actionId, message: readErrorMessage(error) });
    },
  });

  const origin = signal.origin;
  const event = useQuery({
    ...eventQuery(client, origin.type === "event" ? origin.eventId : 0),
    enabled: origin.type === "event",
  });
  const sourceUrl = origin.type === "event" ? (event.data?.url ?? null) : null;
  const sourceName = nameSignalSource(signal, plugins);

  /** Puts the focus in the Reply box of `actionId`, opening it first. */
  const focusReply = (actionId: string): void => {
    flushSync(() => {
      setOpenReplyId(actionId);
    });
    rootRef.current
      ?.querySelector<HTMLTextAreaElement>(`[data-compose-for="${CSS.escape(actionId)}"]`)
      ?.focus();
  };

  const focusSuggested = (): void => {
    if (suggested === undefined || signal.status !== "open") return;
    if (suggested.style === "reply") {
      focusReply(suggested.action.id);
      return;
    }
    const button = rootRef.current?.querySelector<HTMLElement>(
      `[data-action-id="${CSS.escape(suggested.action.id)}"]`,
    );
    button?.focus();
    button?.scrollIntoView({ block: "nearest" });
  };

  const reply = findReplyAnswer(answers);
  useImperativeHandle(ref, () => ({
    focusSuggested,
    openReply: () => {
      if (reply !== undefined && signal.status === "open") focusReply(reply.action.id);
    },
    openOnSource: () => {
      sourceLinkRef.current?.click();
    },
  }));

  useEffect(() => {
    if (!focusSuggestedOnOpen) return;
    focusSuggested();
    onFocusedSuggested();
    // Runs when the screen asks for the focus, not each time the signal changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSuggestedOnOpen]);

  const asker = describeSignalAsker(signal);
  const askedAt = formatMessageTime(new Date(signal.createdAt), timezone, new Date());
  const buildFailure = describeBuildFailure(signal, plugins);
  const outcome = describeSignalOutcome(signal, plugins);
  const resolvedElsewhere =
    openedOpen && !actedHere ? describeResolvedElsewhere(signal, plugins) : null;
  const keptDraft = openReplyId === null ? "" : (drafts[openReplyId] ?? "");

  return (
    <>
      <article ref={rootRef} className="ad">
        <header>
          <div className="ad-kind">
            <span className="src">
              <SourceMark pluginId={readSignalPluginId(signal.kind)} plugins={plugins} size={14} />
              {describeSignalProvenance(signal, plugins)}
            </span>
            <span className="spacer" />
            {sourceUrl !== null && (
              <a
                ref={sourceLinkRef}
                className="btn btn--quiet btn--sm"
                href={sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {`Open on ${sourceName}`}
                <ExternalIcon size={13} />
              </a>
            )}
          </div>
          <h2 className="ad-title">{signal.title}</h2>
          <p className="ad-asked">
            {asker}
            {asker !== null && askedAt !== undefined && " · "}
            {askedAt !== undefined && <time dateTime={signal.createdAt}>{askedAt}</time>}
          </p>
        </header>
        {buildFailure !== null && <p className="ad-flag">{buildFailure}</p>}
        <SignalBlocks blocks={signal.blocks} task={signal.task} timezone={timezone} />
        {outcome === null ? (
          answers.length > 0 && (
            <SignalAnswers
              answers={answers}
              openReplyId={openReplyId}
              drafts={drafts}
              locked={act.isPending}
              failure={failure}
              idPrefix={idPrefix}
              onOpenReply={focusReply}
              onDraftChange={(actionId, text) => {
                setDrafts((current) => ({ ...current, [actionId]: text }));
              }}
              onAct={(actionId, text) => {
                act.mutate(text === undefined ? { actionId } : { actionId, text });
              }}
            />
          )
        ) : (
          <div className="ad-answers">
            <div className="ad-outcome" role="status">
              <span className={outcome.byUser ? "ad-mark ad-mark--you" : "ad-mark"}>
                <CheckIcon size={14} />
              </span>
              <p className="ad-outcome-desc">
                {resolvedElsewhere ?? (
                  <>
                    {outcome.label}: <b>{outcome.outcome}</b>, {outcome.by}
                  </>
                )}
              </p>
            </div>
            {resolvedElsewhere !== null && keptDraft !== "" && (
              <div className="ad-compose">
                <textarea
                  className="ad-compose-input"
                  aria-label="Your reply, not sent"
                  value={keptDraft}
                  readOnly
                />
              </div>
            )}
          </div>
        )}
      </article>
      {signal.status === "open" && (
        <PaneKeys
          suggestedKey={suggested === undefined ? null : describeAnswerKey(suggested, "↩")}
          replyKey={reply === undefined ? null : describeAnswerKey(reply, "R")}
          canOpen={sourceUrl !== null}
        />
      )}
    </>
  );
}

/** Renders the keys at the foot of the pane, each with what it does for this signal. */
function PaneKeys({
  suggestedKey,
  replyKey,
  canOpen,
}: {
  readonly suggestedKey: string | null;
  readonly replyKey: string | null;
  readonly canOpen: boolean;
}): JSX.Element {
  return (
    <div className="ad-keys" aria-hidden="true">
      <span>
        <kbd>J</kbd>
        <kbd>K</kbd> move
      </span>
      {suggestedKey !== null && (
        <span>
          <kbd>↩</kbd> {suggestedKey}
        </span>
      )}
      {replyKey !== null && (
        <span>
          <kbd>R</kbd> {replyKey}
        </span>
      )}
      {canOpen && (
        <span>
          <kbd>O</kbd> open
        </span>
      )}
      <span>
        <kbd>Esc</kbd> close
      </span>
    </div>
  );
}
