/**
 * Telling a session about Discussions (spec 19 section 5.3). The discussions
 * domain drafts the Discussion Input from what the session has not been told
 * yet, the sessions domain stores the row already claimed, and this use case
 * sends it and records what it told once the runner takes it. Sending waits
 * on a runner, so it lives in the controller daemon.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { InvalidState, NotFound, Validation } from "@hercule/contract";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { CurrentActor } from "../../actor";
import { withTransaction } from "../../db";
import { DiscussionService, type DiscussionInputDraft } from "../../discussions";
import type { PluginHost } from "../../plugins";
import { PromotionState } from "../../promotion";
import { resolvedInstance } from "../../providers";
import {
  SessionService,
  sessionRepository,
  type StoredInput,
  type StoredSession,
} from "../../sessions";
import { Live } from "../sessions";

/**
 * When a session is told:
 *
 * - `turnEnd`: its turn has just ended and no other input was sent, so the
 *   Discussion Input may open its next turn;
 * - `entry`: an Edit Overlap has just put it into a Discussion, so a draft
 *   that tells that entry is steered into the running turn, or opens a turn.
 */
export type TellingMoment = "turnEnd" | "entry";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const rows = yield* sessionRepository;
  const discussions = yield* DiscussionService;
  const resolved = yield* resolvedInstance;
  const promotion = yield* PromotionState;
  const { deliverClaimed, interruptTurn } = yield* Live;

  /**
   * One lock per session that a tell holds or waits for. An entry is told at
   * most once per session and Discussion, so two tells of one session must
   * not overlap: a tell that drafted, and then waited on the database or the
   * runner, would otherwise send its draft after the other tell had already
   * sent and recorded the same news. The controller is one process, so a lock
   * in memory is enough. A lock is removed once no tell holds or waits for
   * it, so the map holds only the sessions being told right now.
   */
  const tellLocks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();

  /**
   * Runs `work` while holding the session's tell lock, after every tell of
   * that session that started before it. Tells of different sessions never
   * wait on each other.
   */
  const withTellLock = <A, E, R>(
    sessionId: string,
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        // Synchronous, so two tells that both find no lock cannot each create one.
        const entry = tellLocks.get(sessionId) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
        tellLocks.set(sessionId, entry);
        entry.users += 1;
        return restore(entry.lock.withPermit(work)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.users -= 1;
              if (entry.users === 0) tellLocks.delete(sessionId);
            }),
          ),
        );
      }),
    );

  /**
   * Sends a claimed Discussion Input, and once the runner has taken it,
   * records the draft's mark as told. Does nothing when no row was claimed.
   *
   * A send that fails cancels the row (`SessionService.recordInputAnswer`)
   * and marks nothing, so the session's next turn end drafts it again. The
   * failure is logged, not returned. A runner that took the input but
   * answered too late makes the session hear the same news twice, which does
   * no harm.
   */
  const sendAndMarkTold = (
    claimed: Option.Option<StoredInput>,
    draft: DiscussionInputDraft,
  ): Effect.Effect<void, SqlError> =>
    Option.match(claimed, {
      onNone: () => Effect.void,
      onSome: (row) =>
        deliverClaimed(row).pipe(
          Effect.flatMap(() =>
            withTransaction(sql, discussions.markTold(row.sessionId, draft.told)),
          ),
          Effect.catchIf(
            (error): error is InvalidState | NotFound =>
              error instanceof InvalidState || error instanceof NotFound,
            (error) =>
              Effect.logInfo("A Discussion Input was not delivered", {
                sessionId: row.sessionId,
                reason: error.error.message,
              }),
          ),
        ),
    });

  /**
   * Returns how the session's provider steers a running turn, or `none`,
   * logged, when this build cannot resolve the session's provider instance.
   * A stored configuration that no longer decodes is a bug, so it is a
   * defect.
   */
  const readSteering = (
    session: StoredSession,
  ): Effect.Effect<Option.Option<ProviderDefinition["declared"]["steering"]>, SqlError> =>
    resolved(session.instanceId).pipe(
      Effect.map(({ definition }) => Option.some(definition.declared.steering)),
      Effect.catchIf(
        (error): error is Validation => error instanceof Validation,
        (error) =>
          Effect.as(
            Effect.logWarning(
              "A session was not told about Discussions: its provider is not available",
              { sessionId: session.id, reason: error.error.message },
            ),
            Option.none(),
          ),
      ),
      Effect.catchTag("SchemaError", Effect.die),
    );

  /**
   * Tells the session what it has not been told about its Discussions, if
   * anything, by the session's status at this moment:
   *
   * - a busy session is told only at an `entry`. A provider that steers
   *   natively gets the Discussion Input steered into the running turn. Any
   *   other provider has the turn interrupted, stamped `system`, and nothing
   *   is sent: the turn's end tells the session. An interrupt that cannot
   *   reach the runner is logged, and the session is told when its turn
   *   ends;
   * - an idle session gets the Discussion Input as a new turn, at a
   *   `turnEnd`, and at an `entry` unless it is an agent step's session. An
   *   idle step session is between steps, and a turn opened there would
   *   belong to no step, so it waits for the next step's turn to end;
   * - any other session is told nothing. A queued or starting session's
   *   start carries its first input, and it is told when that turn ends.
   *
   * Nothing is sent to a session that cannot receive a Discussion Input
   * (spec 19 section 5.1), when there is nothing to tell, or at an `entry`
   * when the draft tells no entry. The row is stored only while the session
   * still has the status this read found, and no other input is on the wire
   * (`SessionService.storeClaimedDiscussionInput`).
   *
   * A send or an interrupt that fails is logged, not returned: nothing is
   * lost, because whatever was not told is drafted again at the session's
   * next turn end. So does a session whose provider instance this build
   * cannot resolve. This fails only with a database error.
   *
   * Tells of one session run one at a time, each from the check of whether
   * the session can receive a Discussion Input to the record of what was
   * told. A tell that waited for another one drafts afresh, so it finds
   * nothing to tell that the other tell has sent.
   *
   * The caller runs this after its own transaction has committed. It passes
   * the promotion gate on its own, as `Live.deliverQueuedInput` explains, and
   * everything it writes is the system's doing, whoever's report or request
   * led to it. A tell that waits for another tell of its session is counted
   * at the gate while it waits, so a freeze waits for both.
   */
  const tellSession = (sessionId: string, moment: TellingMoment): Effect.Effect<void, SqlError> =>
    promotion.whenServing(
      withTellLock(
        sessionId,
        Effect.gen(function* () {
          if ((yield* discussions.findDiscussionInputRefusal(sessionId)) !== undefined) return;
          const drafted = yield* discussions.draftDiscussionInput(sessionId);
          if (Option.isNone(drafted)) return;
          const draft = drafted.value;
          if (moment === "entry" && !draft.holdsEntry) return;
          // The caller passes the id of a stored session, and sessions are never deleted.
          const session = Option.getOrThrow(yield* rows.one(sessionId));
          switch (session.status) {
            case "busy": {
              if (moment !== "entry") return;
              const steering = yield* readSteering(session);
              if (Option.isNone(steering)) return;
              if (steering.value !== "native") {
                return yield* interruptTurn(session).pipe(
                  Effect.catchIf(
                    (error): error is InvalidState => error instanceof InvalidState,
                    (error) =>
                      Effect.logInfo("A session was not interrupted to tell it about Discussions", {
                        sessionId,
                        reason: error.error.message,
                      }),
                  ),
                );
              }
              return yield* sendAndMarkTold(
                yield* sessions.storeClaimedDiscussionInput(sessionId, draft.text, "busy"),
                draft,
              );
            }
            case "idle":
              if (moment === "entry" && session.runId !== null) return;
              return yield* sendAndMarkTold(
                yield* sessions.storeClaimedDiscussionInput(sessionId, draft.text, "idle"),
                draft,
              );
            case "queued":
            case "starting":
            case "exited":
              return;
          }
        }),
      ).pipe(Effect.provideService(CurrentActor, { _tag: "none" })),
    );

  return { tellSession };
});

/**
 * Sends Discussion Inputs. `tellSession` checks no grant: the controller
 * writes a Discussion Input itself, at a turn's end or after an Edit Overlap,
 * and no route calls it.
 */
export class DiscussionInputs extends Context.Service<
  DiscussionInputs,
  Effect.Success<typeof make>
>()("hercule/controller/daemon/DiscussionInputs") {}

export const DiscussionInputsLayer: Layer.Layer<
  DiscussionInputs,
  never,
  SqlClient.SqlClient | SessionService | DiscussionService | PluginHost | PromotionState | Live
> = Layer.effect(DiscussionInputs)(make);
