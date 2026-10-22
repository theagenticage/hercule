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
  type ReactNode,
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
import {
  DONE_ACTION_ID,
  type HandoffLeg,
  type IgnoreRuleCreateInput,
  type Signal,
} from "@hercule/contract";
import {
  buildSignalAnswers,
  canIgnoreSignal,
  describeAnswerKey,
  describeBuildFailure,
  describeHandoffTrip,
  describeNotScreened,
  describeOfferedRuleMatchCount,
  describeResolvedElsewhere,
  describeSignalAsker,
  describeSignalOutcome,
  describeSignalOutcomeMoment,
  describeSignalProvenance,
  describeSnoozeLine,
  describeYourWork,
  findReplyAnswer,
  findSuggestedAnswer,
  formatMessageTime,
  hasDoneAction,
  isIgnoreRuleOffer,
  nameSignalSource,
  readErrorMessage,
  parsePluginId,
  planSignalMove,
  readSignalKindLabels,
} from "@hercule/client-core";
import {
  assistantsQuery,
  eventQuery,
  handoffLegQuery,
  pluginsQuery,
  signalQuery,
  workflowsQuery,
} from "../../app/queries";
import { AlarmIcon } from "../../icons/alarm";
import { ExternalIcon } from "../../icons/external";
import { useTrackingRows, useYourWork } from "../../app/tracking";
import { Mark } from "../../marks";
import { HandoffTripHeadline } from "./handoff-trip-line";
import { IgnoreDialog } from "./ignore-dialog";
import { SignalAnswers, type AnswerFailure } from "./signal-answers";
import { SignalBlocks } from "./signal-blocks";
import { SignalPaneMenu } from "./signal-pane-menu";
import { SignalPaneMoves } from "./signal-moves";
import { YourWorkBlocks } from "./your-work-block";
import { SignalMark, SourceMark } from "./source-mark";
import { useOpenSignalsMatchedByRule } from "./use-open-signals-matched-by-rule";
import { useIntakeMoves } from "./use-signal-moves";

/** What Intake's keys do in the pane, called by the screen's key handler. */
export interface SignalPaneHandle {
  /** Opens the first Reply box and puts the focus in it. Does nothing when the signal has none. */
  readonly openReply: () => void;
  /**
   * Does what `O` does: opens the run of a handed-off signal whose trip leads
   * to a run, else the signal on its source, in the default browser. Does
   * nothing when its address is not known.
   */
  readonly openRunOrSource: () => void;
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
 * the screen's keys the pane's moves. `onShowInTracking` is called with a
 * Task's id when the user asks to see the Task's row in Tracking, and
 * `onOpenRun` with a run's id when the user asks to open the run's page.
 * `legs` are the legs of the handoffs on the Done pages, by the run each
 * started, which tell a resolved signal's trip.
 */
export function SignalPane({
  signalId,
  listed,
  timezone,
  shown,
  focusSuggestedOnOpen,
  onFocusedSuggested,
  legs,
  onShowInTracking,
  onOpenRun,
  ref,
}: {
  readonly signalId: string;
  readonly listed: Signal | undefined;
  readonly timezone: string;
  readonly shown: boolean;
  readonly focusSuggestedOnOpen: boolean;
  readonly onFocusedSuggested: () => void;
  readonly legs: ReadonlyMap<string, HandoffLeg>;
  readonly onShowInTracking: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
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
          legs={legs}
          onShowInTracking={onShowInTracking}
          onOpenRun={onOpenRun}
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
  legs,
  onShowInTracking,
  onOpenRun,
  ref,
}: {
  readonly signal: Signal;
  readonly timezone: string;
  readonly focusSuggestedOnOpen: boolean;
  readonly onFocusedSuggested: () => void;
  readonly legs: ReadonlyMap<string, HandoffLeg>;
  readonly onShowInTracking: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
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
  const [ignoring, setIgnoring] = useState(false);
  const [openReplyId, setOpenReplyId] = useState<string | null>(
    suggested?.style === "reply" ? suggested.action.id : null,
  );
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  // `useMutation` drops its error when the next answer starts, and the error
  // must name the answer it belongs to, so the failure is kept here.
  const [failure, setFailure] = useState<AnswerFailure | null>(null);

  // A signal handed off before `signal.handOff` existed starts its run
  // untracked, so no row of Tracking waits to land the flight.
  const isHandOff = (actionId: string): boolean =>
    answers.find((answer) => answer.action.id === actionId)?.action.operation?.op ===
    "signal.handOff";
  const act = useMutation({
    mutationFn: (input: { readonly actionId: string; readonly text?: string }) =>
      client.signal.act({ params: { id: signal.id }, payload: input }),
    onMutate: ({ actionId }) => {
      setFailure(null);
      moves.registerOwnChanges([signal.id]);
      if (isHandOff(actionId)) moves.registerHandoff(signal.id);
    },
    onSuccess: (acted, { actionId }) => {
      setActedHere(true);
      if (isHandOff(actionId)) moves.confirmHandoff(signal.id);
      // The lists need no read here: the answer writes an audit entry on the
      // `signal` topic, and its live push reads every signal list again.
      queryClient.setQueryData(signalQuery(client, signal.id).queryKey, acted);
    },
    onError: (error, input) => {
      moves.forgetOwnChanges([signal.id]);
      moves.forgetHandoff(signal.id);
      setFailure({ actionId: input.actionId, message: readErrorMessage(error) });
    },
  });

  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { data: workflows } = useSuspenseQuery(workflowsQuery(client));
  const { data: assistants } = useSuspenseQuery(assistantsQuery(client));
  const raisers = { workflows, assistants };
  // Your work is read for the signals on To do only, so a signal on Later or Done has none.
  const yourWorkTasks = useYourWork().get(signal.id)?.tasks ?? [];
  const trackingRows = useTrackingRows();
  const yourWork = describeYourWork(yourWorkTasks, trackingRows);
  // Only Done tells a trip. A signal resolved elsewhere while it shows on To
  // do or Later keeps its plain outcome, even when the Done pages know its leg.
  const runId = moves.view === "done" ? signal.resolution?.runId : undefined;
  // A signal whose run is on no loaded Done page, such as one reached by a
  // link to the second page, reads its leg alone.
  const legOnPages = runId === undefined ? undefined : legs.get(runId);
  const readLeg = useQuery({
    ...handoffLegQuery(client, runId ?? ""),
    enabled: runId !== undefined && legOnPages === undefined,
  });
  // A failed read is checked before its data: after a failed refresh, the
  // data it kept is not known to be current, so no trip is drawn from it.
  const legReadFailed = legOnPages === undefined && readLeg.isError;
  const leg = legOnPages ?? (legReadFailed ? undefined : (readLeg.data ?? undefined));
  const trip = describeHandoffTrip(
    signal,
    leg,
    trackingRows.find((row) => row.task.taskId === leg?.taskId),
  );
  const tripRun = trip?.destination.kind === "run" ? trip.destination.runId : null;
  const origin = signal.origin;
  // Only a signal raised from an event has an event to read, so the list of
  // reads is empty for any other signal.
  const eventReads = origin.type === "event" ? [eventQuery(client, origin.eventId)] : [];
  const [event] = useQueries({ queries: eventReads });
  const sourceUrl = event?.data?.url ?? null;
  const sourceName = nameSignalSource(signal, plugins, raisers);
  const sourcePluginId = parsePluginId(signal.kind);
  const provenance = (
    <>
      <SignalMark signal={signal} plugins={plugins} size={14} />
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
    // A resolved signal takes no answer. Its trip's button is what `↩` presses.
    if (signal.status !== "open") {
      rootRef.current?.querySelector<HTMLElement>("[data-trip-button]")?.focus();
      return;
    }
    if (suggested === undefined) return;
    if (suggested.style === "reply") {
      focusReply(suggested.action.id);
      return;
    }
    const button = rootRef.current?.querySelector<HTMLElement>(
      `[data-answer="${CSS.escape(suggested.action.id)}"]`,
    );
    button?.focus();
    button?.scrollIntoView({ block: "nearest" });
  };

  const reply = findReplyAnswer(answers);
  useImperativeHandle(ref, () => ({
    openReply: () => {
      if (reply !== undefined && signal.status === "open") focusReply(reply.action.id);
    },
    openRunOrSource: () => {
      if (tripRun !== null) onOpenRun(tripRun);
      else sourceLinkRef.current?.click();
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
  const askedTime =
    askedAt === undefined ? null : <time dateTime={signal.createdAt}>{askedAt}</time>;
  // Hercule's offer names no asker. While it is open, its line counts what
  // the rule it offers would take off the list instead.
  const offeredRule =
    signal.status === "open" && isIgnoreRuleOffer(signal) ? signal.ignoreRule : undefined;
  const canIgnore = canIgnoreSignal(signal, readSignalKindLabels(plugins, signal.kind));
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

  // The trip's button goes when its leg leaves the read, as when the Task is
  // deleted. The failure line and its "Try again" button go when the read
  // succeeds. If either had the focus, the focus falls to the page's body and
  // the screen's keys stop working. It moves to the trip's button when there is
  // one, the natural next step after a successful retry, and to the pane
  // otherwise.
  const hasTrip = trip !== null;
  const hadControlsRef = useRef({ trip: false, failure: false });
  useLayoutEffect(() => {
    const had = hadControlsRef.current;
    hadControlsRef.current = { trip: hasTrip, failure: legReadFailed };
    const lostControl = (had.trip && !hasTrip) || (had.failure && !legReadFailed);
    if (!lostControl) return;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return;
    const tripButton = rootRef.current?.querySelector<HTMLElement>("[data-trip-button]");
    (tripButton ?? rootRef.current)?.focus();
  }, [hasTrip, legReadFailed]);

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
            {canIgnore && (
              <SignalPaneMenu
                sourceName={sourceName}
                sourceUrl={sourceUrl}
                onIgnore={() => {
                  setIgnoring(true);
                }}
              />
            )}
          </div>
          <h2 className="ad-title">{signal.title}</h2>
          <p className="ad-asked">
            {offeredRule === undefined ? (
              <>
                {asker}
                {asker !== null && askedTime !== null && " · "}
                {askedTime}
              </>
            ) : (
              <OfferedRuleMatchCount rule={offeredRule} time={askedTime} />
            )}
          </p>
        </header>
        {snoozeLine !== null && (
          <p className="ad-flag">
            <AlarmIcon size={14} />
            {snoozeLine}
          </p>
        )}
        <SignalBlocks blocks={signal.blocks} task={signal.task} timezone={timezone} />
        <YourWorkBlocks items={yourWork} onShowInTracking={onShowInTracking} />
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
                    <SourceMark pluginId={parsePluginId(signal.kind)} plugins={plugins} size={16} />
                  )}
                </span>
                <span className="b-work-text">
                  <span className="b-work-label">{outcome.label}</span>
                  {trip === null ? <b>{outcome.outcome}</b> : <HandoffTripHeadline trip={trip} />}
                  <span>{outcomeMoment}</span>
                </span>
                {trip !== null && (
                  <button
                    type="button"
                    className="btn btn--sm ad-outcome-button"
                    data-trip-button
                    onClick={() => {
                      if (trip.destination.kind === "tracking") {
                        onShowInTracking(trip.destination.taskId);
                      } else onOpenRun(trip.destination.runId);
                    }}
                  >
                    {trip.destination.kind === "tracking" ? "Go to Tracking" : "Open the run"}
                  </button>
                )}
                {legReadFailed && (
                  <div className="ad-outcome-failure">
                    <p className="ad-err" role="alert">
                      {`Couldn't read where this handoff stands. ${readErrorMessage(readLeg.error)}`}
                    </p>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={readLeg.isFetching}
                      onClick={() => {
                        void readLeg.refetch();
                      }}
                    >
                      {readLeg.isFetching ? "Trying again…" : "Try again"}
                    </button>
                  </div>
                )}
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
      {ignoring && (
        <IgnoreDialog
          signal={signal}
          onCreated={() => {
            setActedHere(true);
          }}
          onClose={() => {
            setIgnoring(false);
          }}
        />
      )}
      {signal.status === "open" ? (
        <PaneKeys
          suggestedKey={suggested === undefined ? null : describeAnswerKey(suggested, "↩")}
          replyKey={reply === undefined ? null : describeAnswerKey(reply, "R")}
          canMarkDone={hasDoneAction(signal)}
          canSnooze
          later={moves.view === "later"}
          canOpen={sourceUrl !== null}
          tripDestination={null}
        />
      ) : (
        <PaneKeys
          suggestedKey={null}
          replyKey={null}
          canMarkDone={false}
          canSnooze={false}
          later={false}
          canOpen={sourceUrl !== null}
          tripDestination={trip?.destination.kind ?? null}
        />
      )}
    </>
  );
}

/**
 * Renders the line under the title of Hercule's open offer: how many open
 * signals the offered rule `rule` matches, "3 open now", then `time`, when
 * the offer was raised. Until the count is read, or when it cannot be, the
 * line shows only `time`.
 */
function OfferedRuleMatchCount({
  rule,
  time,
}: {
  readonly rule: IgnoreRuleCreateInput;
  readonly time: ReactNode;
}): JSX.Element {
  const matched = useOpenSignalsMatchedByRule(rule);
  return (
    <>
      {matched.state === "read" && describeOfferedRuleMatchCount(matched.signals.length)}
      {matched.state === "read" && time !== null && " · "}
      {time}
    </>
  );
}

/**
 * Renders the keys at the foot of the pane, each with what it does for this
 * signal. `later` is set when the pane shows a signal on Later, which `U`
 * puts back on To do. A resolved signal takes no answer and no move, so its
 * foot keeps only J K, O and Esc. `tripDestination` is where the trip of a
 * handed-off signal on Done leads: `↩` goes to Tracking, and `O` opens the run
 * in place of the source.
 */
function PaneKeys({
  suggestedKey,
  replyKey,
  canMarkDone,
  canSnooze,
  later,
  canOpen,
  tripDestination,
}: {
  readonly suggestedKey: string | null;
  readonly replyKey: string | null;
  readonly canMarkDone: boolean;
  readonly canSnooze: boolean;
  readonly later: boolean;
  readonly canOpen: boolean;
  readonly tripDestination: "tracking" | "run" | null;
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
      {tripDestination === "tracking" && (
        <span>
          <kbd>↩</kbd> go to Tracking
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
      {tripDestination === "run" ? (
        <span>
          <kbd>O</kbd> open the run
        </span>
      ) : (
        canOpen && (
          <span>
            <kbd>O</kbd> open
          </span>
        )
      )}
      <span>
        <kbd>Esc</kbd> close
      </span>
    </div>
  );
}
