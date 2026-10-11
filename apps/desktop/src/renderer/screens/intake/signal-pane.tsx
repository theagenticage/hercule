/**
 * Intake's pane: the open signal, top to bottom as spec 17 §The pane lists
 * it, with its answers and the keys at its foot.
 */
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type Ref,
} from "react";
import { flushSync } from "react-dom";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { DONE_ACTION_ID, type Signal } from "@hercule/contract";
import {
  buildSignalAnswers,
  describeAnswerKey,
  describeBuildFailure,
  describeNotScreened,
  describeResolvedElsewhere,
  describeSignalAsker,
  describeSignalOutcome,
  describeSignalOutcomeMoment,
  describeSignalProvenance,
  describeSnoozeLine,
  findReplyAnswer,
  findSuggestedAnswer,
  formatMessageTime,
  hasDoneAction,
  nameSignalSource,
  readErrorMessage,
  parseSignalPluginId,
  planSignalMove,
} from "@hercule/client-core";
import {
  assistantsQuery,
  eventQuery,
  pluginsQuery,
  signalQuery,
  workflowsQuery,
} from "../../app/queries";
import { AlarmIcon } from "../../icons/alarm";
import { ExternalIcon } from "../../icons/external";
import { Mark } from "../../marks";
import { SignalAnswers, type AnswerFailure } from "./signal-answers";
import { SignalBlocks } from "./signal-blocks";
import { SignalPaneMoves } from "./signal-moves";
import { SourceMark } from "./source-mark";
import { useIntakeMoves } from "./use-signal-moves";

/** What Intake's keys do in the pane, called by the screen's key handler. */
export interface SignalPaneHandle {
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
 * `shown` is false while the pane slides out. The pane is inert then: on
 * its way off screen, it takes no focus and screen readers skip it.
 *
 * `focusSuggestedOnOpen` puts the focus on the suggested answer as soon as
 * the pane shows the signal, then calls `onFocusedSuggested`. `ref` gives
 * the screen's keys the pane's moves.
 */
export function SignalPane({
  signalId,
  listed,
  timezone,
  shown,
  focusSuggestedOnOpen,
  onFocusedSuggested,
  ref,
}: {
  readonly signalId: string;
  readonly listed: Signal | undefined;
  readonly timezone: string;
  readonly shown: boolean;
  readonly focusSuggestedOnOpen: boolean;
  readonly onFocusedSuggested: () => void;
  readonly ref: Ref<SignalPaneHandle>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const read = useQuery({ ...signalQuery(client, signalId), placeholderData: () => listed });
  return (
    <section className="asks-detail" aria-label="The open signal" inert={!shown}>
      {read.data !== undefined ? (
        <SignalDetail
          key={signalId}
          signal={read.data}
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
  timezone,
  focusSuggestedOnOpen,
  onFocusedSuggested,
  ref,
}: {
  readonly signal: Signal;
  readonly timezone: string;
  readonly focusSuggestedOnOpen: boolean;
  readonly onFocusedSuggested: () => void;
  readonly ref: Ref<SignalPaneHandle>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const moves = useIntakeMoves();
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
      // The lists need no read here: the answer writes an audit entry on the
      // `signal` topic, and its live push reads every signal list again.
      queryClient.setQueryData(signalQuery(client, signal.id).queryKey, acted);
    },
    onError: (error, input) => {
      setFailure({ actionId: input.actionId, message: readErrorMessage(error) });
    },
  });

  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { data: workflows } = useSuspenseQuery(workflowsQuery(client));
  const { data: assistants } = useSuspenseQuery(assistantsQuery(client));
  const raisers = { workflows, assistants };
  const origin = signal.origin;
  // Only a signal raised from an event has an event to read, so the list of
  // reads is empty for any other signal.
  const eventReads = origin.type === "event" ? [eventQuery(client, origin.eventId)] : [];
  const [event] = useQueries({ queries: eventReads });
  const sourceUrl = event?.data?.url ?? null;
  const sourceName = nameSignalSource(signal, plugins, raisers);
  const sourcePluginId = parseSignalPluginId(signal.kind);
  const provenance = (
    <>
      <SourceMark pluginId={sourcePluginId} plugins={plugins} size={14} />
      {describeSignalProvenance(signal, plugins, raisers)}
    </>
  );

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
  const buildFailure = describeBuildFailure(signal, plugins, raisers);
  const notScreened = describeNotScreened(signal);
  const outcome = describeSignalOutcome(signal, plugins);
  const now = new Date();
  const outcomeMoment = describeSignalOutcomeMoment(signal, plugins, now, timezone);
  const snoozeLine =
    moves.view === "later"
      ? describeSnoozeLine(signal, now, timezone, sourceUrl === null ? null : sourceName)
      : null;
  const resolvedElsewhere =
    openedOpen && !actedHere ? describeResolvedElsewhere(signal, plugins) : null;
  const keptDraft = openReplyId === null ? "" : (drafts[openReplyId] ?? "");

  // When the signal resolves while the pane shows it, its answers and its
  // Reply box are removed. If one of them had the focus, the focus falls to
  // the page's body, outside the screen's keys, and J, K and Esc stop
  // working. The focus moves to the pane instead. It never moves to the kept
  // reply, a text box where the keys do not act.
  const resolved = outcome !== null;
  useLayoutEffect(() => {
    if (!openedOpen || !resolved) return;
    const focused = document.activeElement;
    if (focused === null || focused === document.body) rootRef.current?.focus();
  }, [openedOpen, resolved]);

  return (
    <>
      <article ref={rootRef} className="ad" tabIndex={-1}>
        <header>
          <div className="ad-kind">
            {sourcePluginId === null ? (
              <span className="src">{provenance}</span>
            ) : (
              // The line of a plugin's signal opens that signal kind on Settings > Intake,
              // on the Connection the signal came from when it came from an event.
              <Link
                className="src"
                to="/settings/intake"
                search={{
                  kind: signal.kind,
                  ...(origin.type === "event" ? { connection: origin.connectionId } : {}),
                }}
              >
                {provenance}
              </Link>
            )}
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
        {snoozeLine !== null && (
          <p className="ad-flag">
            <AlarmIcon size={14} />
            {snoozeLine}
          </p>
        )}
        <SignalBlocks blocks={signal.blocks} task={signal.task} timezone={timezone} />
        {buildFailure !== null && <p className="ad-flag">{buildFailure}</p>}
        {notScreened !== null && <p className="ad-flag">{notScreened}</p>}
        {outcome === null ? (
          answers.length > 0 && (
            <SignalAnswers
              answers={answers}
              openReplyId={openReplyId}
              drafts={drafts}
              locked={act.isPending || moves.pending}
              failure={failure}
              idPrefix={idPrefix}
              onOpenReply={focusReply}
              onDraftChange={(actionId, text) => {
                setDrafts((current) => ({ ...current, [actionId]: text }));
              }}
              onAct={(actionId, text) => {
                // Done takes the signal off the list with `signal.markDone`, as on a row.
                if (actionId === DONE_ACTION_ID) {
                  setActedHere(true);
                  moves.run(planSignalMove([signal], "done"));
                } else act.mutate(text === undefined ? { actionId } : { actionId, text });
              }}
            />
          )
        ) : (
          <div className="ad-answers">
            <section className="ad-outcome" role="status">
              <div className="ad-outcome-top">
                <span className={outcome.byUser ? "ad-mark" : "ad-mark ad-mark--quiet"}>
                  {outcome.byUser ? (
                    <Mark state="done" size={16} />
                  ) : signal.resolution?.kind === "withdrawn" ? (
                    <Mark state="idle" size={16} />
                  ) : (
                    <SourceMark
                      pluginId={parseSignalPluginId(signal.kind)}
                      plugins={plugins}
                      size={16}
                    />
                  )}
                </span>
                <span className="b-work-text">
                  <span className="b-work-label">{outcome.label}</span>
                  <b>{outcome.outcome}</b>
                  <span>{outcomeMoment}</span>
                </span>
              </div>
              {resolvedElsewhere !== null && <p className="ad-outcome-desc">{resolvedElsewhere}</p>}
            </section>
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
        <SignalPaneMoves signal={signal} />
      </article>
      {signal.status === "open" ? (
        <PaneKeys
          suggestedKey={suggested === undefined ? null : describeAnswerKey(suggested, "↩")}
          replyKey={reply === undefined ? null : describeAnswerKey(reply, "R")}
          canMarkDone={hasDoneAction(signal)}
          canSnooze
          later={moves.view === "later"}
          canOpen={sourceUrl !== null}
        />
      ) : (
        <PaneKeys
          suggestedKey={null}
          replyKey={null}
          canMarkDone={false}
          canSnooze={false}
          later={false}
          canOpen={sourceUrl !== null}
        />
      )}
    </>
  );
}

/**
 * Renders the keys at the foot of the pane, each with what it does for this
 * signal. `later` is set when the pane shows a signal on Later, which `U`
 * puts back on To do. A resolved signal takes no answer and no move, so its
 * foot keeps only J K, O and Esc.
 */
function PaneKeys({
  suggestedKey,
  replyKey,
  canMarkDone,
  canSnooze,
  later,
  canOpen,
}: {
  readonly suggestedKey: string | null;
  readonly replyKey: string | null;
  readonly canMarkDone: boolean;
  readonly canSnooze: boolean;
  readonly later: boolean;
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
      {canMarkDone && (
        <span>
          <kbd>E</kbd> done
        </span>
      )}
      {canSnooze && (
        <span>
          <kbd>H</kbd> snooze
        </span>
      )}
      {later && (
        <span>
          <kbd>U</kbd> unsnooze
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
