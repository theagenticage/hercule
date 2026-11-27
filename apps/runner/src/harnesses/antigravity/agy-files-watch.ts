/**
 * The one owner of everything that watches `agy`'s own session files for a
 * session: it decides when to read them, gives what they hold to whoever shows
 * it, and tells the user when they cannot be read (spec 06 sections 6.6 and
 * 13.6). The files show the subagents' work and tokens, which ACP does not
 * carry.
 *
 * It uses `agy-files.ts` to read the files, and `subagents.ts` to turn a
 * subagent's steps into events. Both keep their own tests. What is left here is
 * the timing and the routing:
 *
 * - It reads every `FILE_READ_INTERVAL` while work is open, and for
 *   `FILE_READ_TAIL` after the last of it closed, because the files lag ACP.
 *   While nothing is open it waits, so an idle session costs nothing.
 * - It keeps reading while the reader holds the steps of a subagent that waits
 *   for its link, because that wait ends by itself.
 * - It shows the session's own transcript to the running Turn (as facts), and a
 *   subagent's to `subagents.ts`.
 * - It closes the reader when the session's own files cannot be read, or when a
 *   Turn replied and `agy` wrote no transcript.
 *
 * The interface is small on purpose. The session says when its own work is open
 * and when a Turn replied, and it gets back `wake`, `settleAfterCancel` and
 * the question whether a subagent has a turn open. It never sees a file, a
 * reader or an observation. Events go out through `publish`, which the session
 * gives already hiding its token, so no event of the files can skip that.
 *
 * Time is measured on Effect's clock, so tests run it on a `TestClock`.
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { HarnessEvent } from "@hercule/protocol";
import { escapeControlCharacters } from "../../report";
import { buildEnvelope } from "../normalize";
import { truncateFact, truncateMessage } from "../text";
import { openAgyFiles, readRootConversationFact } from "./agy-files";
import type { AgyFileObservation, AgyFiles, RootConversationFact } from "./agy-files";
import { findLaunchItem } from "./normalize";
import type { NormalizerState } from "./normalize";
import {
  buildSubagentsState,
  buildTooManySubagentsEvents,
  endUnreadableSubagent,
  endUnreadableSubagents,
  hasOpenSubagentTurn,
  interruptSubagentTurns,
  introduceSubagent,
  normalizeSubagentStep,
} from "./subagents";

/**
 * How often the files are read while something is open. A subagent's steps
 * show up in the files within half a second, so a slower read would lag what
 * the user sees. Nothing is read while no work is open, so a short interval
 * costs nothing in an idle session.
 */
const FILE_READ_INTERVAL = Duration.millis(500);

/**
 * How long the files are read after the last open work closed. The files lag
 * what `agy` sends over ACP: in the recording `subagent-full` a subagent's last
 * step was written 80 ms after its parent's reply, and a child's launch message
 * 100 ms after its folder appeared. One read at the close would miss them.
 */
const FILE_READ_TAIL = Duration.seconds(2);

/**
 * How long `settleAfterCancel` waits after `agy` answered a cancel, before it
 * reads the files a last time and ends the subagent turns. A subagent's step
 * reaches its file up to about 100 ms after `agy` wrote it to ACP (80 ms and
 * 100 ms in the recording `subagent-full`), so a step written just before the
 * cancel would otherwise be read after its turn ended.
 */
const CANCEL_FILE_LAG = Duration.millis(250);

/** What the watcher offers the session that started it. */
export interface AgyFilesWatch {
  /** Lets the watcher go on reading when it waits for work to open. It checks for itself that some is open. */
  readonly wake: () => void;
  /** Records that a Turn of the session's own agent ended with its reply. The watcher then knows that a transcript with no step in it is missing. */
  readonly recordSessionReply: () => void;
  /** Checks whether some subagent has a turn open, so the session knows a cancel has something to stop. */
  readonly hasOpenSubagentTurn: () => boolean;
  /**
   * Ends the open subagent turns as `interrupted` once `agy` took a
   * `session/cancel`, which stops every subagent. It waits `CANCEL_FILE_LAG`
   * (when a subagent turn is open) and reads the files once first, so the
   * steps a subagent wrote before the cancel are shown before its turn ends.
   */
  readonly settleAfterCancel: Effect.Effect<void>;
}

/**
 * Starts watching the files of the conversation `conversationId` in the
 * Harness Home `home`, and returns what the session needs of it. The reading
 * fiber lives in the scope that is provided, so closing that scope (the end of
 * the process) ends it.
 *
 * The conversation is the one the `normalizer` belongs to.
 *
 * - `resumes` is true for a resumed session: what the files hold now is then
 *   not shown again. The files are scanned when this effect runs, so the caller
 *   must run it before it sends its first prompt.
 * - `known` are the subagents of an earlier process of the session
 *   (`continue.subagents`).
 * - `normalizer` is the session's own normalizer state. Its launch items link a
 *   subagent to the call that started it, and its usage snapshot includes the
 *   subagents' tokens.
 * - `isSessionWorkOpen` tells whether the session's own work is open: the Turn,
 *   or a synthetic turn.
 * - `publish` shows events, with the session token already hidden.
 * - `recordRootConversationFact` gives the running Turn a fact of the session's
 *   own transcript. It does nothing when no Turn runs.
 *
 * Never fails.
 */
export const watchAgyFiles = (input: {
  readonly home: string;
  readonly resumes: boolean;
  readonly known: ReadonlyArray<{ readonly subagentId: string }>;
  readonly normalizer: NormalizerState;
  readonly isSessionWorkOpen: () => boolean;
  readonly publish: (events: ReadonlyArray<HarnessEvent>) => void;
  readonly recordRootConversationFact: (fact: RootConversationFact) => void;
}): Effect.Effect<AgyFilesWatch, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { normalizer, publish } = input;
    const conversationId = normalizer.nativeSessionId;
    const subagents = buildSubagentsState({ normalizer, known: input.known });
    /** Undefined once the session's own files proved unreadable. */
    let reader: AgyFiles | undefined = yield* openAgyFiles({
      home: input.home,
      conversationId,
      skipExisting: input.resumes,
    });
    /** Whether the reader showed a step of the session's own conversation. `agy` writes the first prompt there within seconds, so a Turn that replied with none shown means it wrote no transcript. */
    let hasSeenOwnStep = false;
    let hasSessionReplied = false;
    /** Lets only one read run at a time: the loop and a cancel both read. */
    const readLock = Semaphore.makeUnsafe(1);
    /** Whether the last read left a subagent that waits for its link, so the loop reads again although no work is open. */
    let isAwaitingLink = false;
    /** Completes when work opens while the loop waits for it. */
    let wakeSignal: Deferred.Deferred<void> | undefined;

    const buildSessionEnvelope = () =>
      buildEnvelope(normalizer.sessionId, { nativeSessionId: conversationId });

    const escapeReportedText = (text: string): string =>
      truncateFact(escapeControlCharacters(text));

    const isWorkOpen = (): boolean => input.isSessionWorkOpen() || hasOpenSubagentTurn(subagents);

    /**
     * Returns the events for files that could not be read: a warning, and the
     * end of every subagent that can no longer be read. When the files are the
     * session's own, the reader closes for the rest of the process and every
     * known subagent ends. Else only the subagent of those files ends. Either
     * way the session's usage is then incomplete.
     */
    const closeUnreadableFiles = (unreadableId: string, reason: string): HarnessEvent[] => {
      if (unreadableId === conversationId) {
        reader = undefined;
        return [
          {
            _tag: "runtime.warning",
            ...buildSessionEnvelope(),
            message: truncateMessage(
              `Hercule cannot read Antigravity's session files (${escapeReportedText(reason)}), so subagents' work is not shown and their tokens are not counted.`,
            ),
          },
          ...endUnreadableSubagents(subagents),
        ];
      }
      return [
        {
          _tag: "runtime.warning",
          ...buildSessionEnvelope(),
          message: truncateMessage(
            `Hercule cannot read the session files of the Antigravity subagent ${unreadableId} (${escapeReportedText(reason)}), so its work is not shown and its tokens are not counted.`,
          ),
        },
        ...endUnreadableSubagent(subagents, unreadableId),
      ];
    };

    /**
     * Returns the events one observation of the files causes. A step of the
     * session's own conversation goes to the running Turn, which emits what it
     * shows itself.
     */
    const routeObservation = (observation: AgyFileObservation): HarnessEvent[] => {
      switch (observation.kind) {
        case "step": {
          if (observation.conversationId !== conversationId) {
            return normalizeSubagentStep(subagents, observation.conversationId, observation.step);
          }
          hasSeenOwnStep = true;
          const fact = readRootConversationFact(observation.step);
          if (fact !== undefined) input.recordRootConversationFact(fact);
          return [];
        }
        case "subagent":
          // The launch item is found by `agy`'s call id in the launch message.
          return introduceSubagent(subagents, observation.link, (toolCallId) =>
            findLaunchItem(normalizer, toolCallId),
          );
        case "unreadable":
          return closeUnreadableFiles(observation.conversationId, observation.reason);
        case "too-many-subagents":
          return buildTooManySubagentsEvents(subagents);
      }
    };

    /** Reads what is new in the files once and publishes what follows. Only one read runs at a time. */
    const readOnce: Effect.Effect<void> = readLock.withPermits(1)(
      Effect.suspend(() => {
        const current = reader;
        if (current === undefined) return Effect.void;
        return Effect.map(current.read, (result) => {
          isAwaitingLink = result.isAwaitingLink;
          for (const observation of result.observations) publish(routeObservation(observation));
        });
      }),
    );

    /**
     * Closes the reader for the session's own files when a Turn replied and
     * the reader never showed a step of them: `agy` wrote no transcript for
     * this conversation, so waiting longer shows nothing.
     */
    const endWithoutTranscript = Effect.sync(() => {
      if (reader === undefined || !hasSessionReplied || hasSeenOwnStep) return;
      publish(
        closeUnreadableFiles(conversationId, "agy wrote no transcript for this conversation"),
      );
    });

    /**
     * Reads every `FILE_READ_INTERVAL` while work is open, and for
     * `FILE_READ_TAIL` after the last of it closed. It also keeps reading
     * while the reader awaits a link it will settle within 2 seconds. Then it
     * waits until work opens again. One fiber does all of it, so nothing is
     * read or timed while the session is idle.
     */
    const readWhileWorkIsOpen = Effect.gen(function* () {
      let wasOpen = false;
      let tailEndsAt: number | undefined;
      // A closed reader stays closed, so the loop ends with it.
      while (reader !== undefined) {
        const now = yield* Clock.currentTimeMillis;
        const isOpen = isWorkOpen();
        if (isOpen) {
          wasOpen = true;
        } else if (wasOpen) {
          wasOpen = false;
          tailEndsAt = now + Duration.toMillis(FILE_READ_TAIL);
        }
        if (isOpen || isAwaitingLink || (tailEndsAt !== undefined && now < tailEndsAt)) {
          yield* readOnce;
          yield* Effect.sleep(FILE_READ_INTERVAL);
        } else if (tailEndsAt !== undefined) {
          tailEndsAt = undefined;
          yield* endWithoutTranscript;
        } else {
          const opened = Deferred.makeUnsafe<void>();
          wakeSignal = opened;
          yield* Deferred.await(opened);
          wakeSignal = undefined;
        }
      }
    });
    yield* Effect.forkScoped(readWhileWorkIsOpen);

    const settleAfterCancel = Effect.gen(function* () {
      // Only a turn that is open has a step that can still be on its way.
      if (hasOpenSubagentTurn(subagents)) yield* Effect.sleep(CANCEL_FILE_LAG);
      yield* readOnce;
      publish(interruptSubagentTurns(subagents));
    });

    return {
      wake: () => {
        if (wakeSignal !== undefined) Deferred.doneUnsafe(wakeSignal, Effect.void);
      },
      recordSessionReply: () => {
        hasSessionReplied = true;
      },
      hasOpenSubagentTurn: () => hasOpenSubagentTurn(subagents),
      settleAfterCancel,
    } satisfies AgyFilesWatch;
  });
