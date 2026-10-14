/**
 * Makes text generations: picks the runner, sends the call, waits for the
 * answer and writes the record. The `TextGeneration` port in the
 * text generation domain describes what a caller gets; this file is how it is
 * done.
 *
 * Nothing durable is created for a call but its audit entry. A call lost to a
 * restart leaves nothing behind.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { TextGenerationFailureReason } from "@hercule/contract";
import {
  lintOutputSchema,
  MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER,
  MAX_TEXT_GENERATION_TEXT_LENGTH,
  TEXT_GENERATION_DEADLINE_MS,
  type Usage,
} from "@hercule/protocol";
import { findJsonSchemaViolation } from "@hercule/protocol/json-schema";
import { SYSTEM_ACTOR } from "../../actor";
import { nowIso } from "../../db";
import { AuditLog } from "../../events";
import { PluginHost } from "../../plugins";
import { PromotionState } from "../../promotion";
import { LocalRunnerId, RunnerConnections, type Answer, type SendOutcome } from "../../runners";
import { readInstanceSecrets, Secrets } from "../../secrets";
import {
  explainTextGenerationUnavailable,
  LastTextGenerationFailure,
  TextGeneration,
  TextGenerationError,
  TextGenerationModels,
  type TextGenerationCall,
  type TextGenerationCaller,
  type TextGenerationTarget,
} from "../../text-generation";

/**
 * How long a call holds its slot, at most, after the request is sent. The
 * runner stops its harness at `TEXT_GENERATION_DEADLINE_MS`, waits for the
 * harness process to exit, and only then answers. The slowest harness to stop
 * is Claude Code: its SDK waits about 2 seconds for the process to exit, and
 * the runner then sends SIGTERM and, 2 seconds later, SIGKILL. So the answer
 * can arrive about 64 seconds after the request. The extra 10 seconds cover
 * that and the answer travelling back. The limit also
 * bounds the hold for a runner that breaks its promise to answer, so such a
 * runner cannot keep slots for good.
 */
const SLOT_HOLD_MS = TEXT_GENERATION_DEADLINE_MS + 10_000;

/**
 * How long a caller waits for the runner's answer, counted from the moment
 * its call holds a slot on the runner. The wait for a free slot does not
 * count, so a burst of calls queued on a busy runner waits its turn instead
 * of timing out. A caller that gives up at this deadline gets a `timeout`
 * error, but its call keeps its slot until the runner answers (see
 * `callRunner`). Tests override it with a shorter one.
 */
export const TextGenerationDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/TextGenerationDeadline",
  { defaultValue: (): Duration.Duration => Duration.millis(TEXT_GENERATION_DEADLINE_MS) },
);

const TIMED_OUT =
  "the text generation did not finish in time; the model may be slow, or the runner busy or not answering";

const INVALID_OUTPUT = "the model's answer did not match the output schema";

const CONNECTION_ENDED = "the runner's connection ended before it answered";

const NO_REASON = "the text generation failed, and no reason was given";

const NOT_SENT =
  "the call was not sent, because the runner is not connected or cannot make text generations";

const UNEXPECTED_FAILURE =
  "the text generation stopped on an unexpected error; the controller log has the details";

/** A target that names the instance and model a call runs on. */
type ResolvedTarget = Extract<TextGenerationTarget, { readonly _tag: "resolved" }>;

/** How a call ended, before it is turned into a value or an error. */
type Outcome =
  | { readonly _tag: "completed"; readonly value: unknown; readonly usage: Usage | null }
  | {
      readonly _tag: "failed";
      readonly reason: TextGenerationFailureReason;
      readonly message: string;
    };

/** An outcome, and the runner it came from, which is null when no runner was chosen. */
interface Attempt {
  readonly runnerId: string | null;
  readonly outcome: Outcome;
}

/**
 * Builds the attempt of a call that failed. The message is trimmed, and a
 * blank one becomes a fixed text, because Settings shows the message as the
 * reason and the status refuses an empty one. The protocol already refuses a
 * blank message from a runner, so the fixed text is a safeguard for the
 * controller's own messages.
 */
const buildFailedAttempt = (
  reason: TextGenerationFailureReason,
  message: string,
  runnerId: string | null = null,
): Attempt => ({
  runnerId,
  outcome: { _tag: "failed", reason, message: message.trim() || NO_REASON },
});

/**
 * Decides how a call that was sent to `runnerId` ended, from what the
 * connection returned:
 *
 * - not sent: `unavailable`, because the runner is not connected or cannot
 *   make text generations;
 * - no report, because the connection ended: `unavailable`;
 * - the runner's report: its outcome. An `ok` value that does not match the
 *   output schema is `invalid-output`.
 */
const decideAttempt = (
  runnerId: string,
  call: TextGenerationCall,
  sent: SendOutcome<Answer>,
): Attempt => {
  if (sent._tag === "notSent") return buildFailedAttempt("unavailable", NOT_SENT, runnerId);
  const answer = sent.answer;
  if (Option.isNone(answer) || answer.value._tag !== "textGenerationReport") {
    return buildFailedAttempt("unavailable", CONNECTION_ENDED, runnerId);
  }
  const reported = answer.value.outcome;
  switch (reported.outcome) {
    case "failed":
      return buildFailedAttempt("failed", reported.message, runnerId);
    case "timeout":
      return buildFailedAttempt("timeout", TIMED_OUT, runnerId);
    case "invalid-output":
      // The reason is left out on purpose: it can quote the model's output,
      // and the record and the status must never hold it.
      return buildFailedAttempt("invalid-output", INVALID_OUTPUT, runnerId);
    case "ok":
      // The runner checks the answer too, but the controller does not
      // trust a runner with what it hands to its callers.
      return findJsonSchemaViolation(call.outputSchema, reported.value) === undefined
        ? {
            runnerId,
            outcome: { _tag: "completed", value: reported.value, usage: reported.usage },
          }
        : buildFailedAttempt("invalid-output", INVALID_OUTPUT, runnerId);
  }
};

/**
 * Removes the `core:`, `plugin:` or `run:` prefix, which the record keeps as
 * the caller. What is left qualifies the purpose: `sessions/thread.title` for
 * the sessions domain, `<runId>/<stepId>` for a step of a run.
 */
const readCallerId = (caller: TextGenerationCaller): string =>
  caller.slice(caller.indexOf(":") + 1);

const make = Effect.gen(function* () {
  const models = yield* TextGenerationModels;
  const lastFailure = yield* LastTextGenerationFailure;
  const connections = yield* RunnerConnections;
  const secrets = yield* Secrets;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;
  const promotion = yield* PromotionState;
  const localRunnerId = yield* LocalRunnerId;

  // The fibers that hold a runner's slot while it works. They belong to the
  // layer, not to the caller, because a caller that stops waiting must not
  // free a slot the runner is still using.
  const slotHolders = yield* FiberSet.make<void, never>();

  // One semaphore per runner, created the first time a call lands on it. They
  // live in memory only: after a restart no call is in flight. An entry stays
  // after its runner is retired; the map is as large as the fleet has ever been.
  const slotsByRunner = new Map<string, Semaphore.Semaphore>();
  const getOrCreateRunnerSlots = (runnerId: string): Semaphore.Semaphore => {
    const existing = slotsByRunner.get(runnerId);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER);
    slotsByRunner.set(runnerId, created);
    return created;
  };

  /**
   * Chooses the runner for the call among those that could take it: the local
   * runner if it is one of them, otherwise the one with the lowest id.
   */
  const chooseRunner = (runnerIds: ReadonlyArray<string>): string | undefined => {
    const local = localRunnerId.read();
    return [...runnerIds].sort(
      (a, b) => Number(b === local) - Number(a === local) || a.localeCompare(b),
    )[0];
  };

  /**
   * Writes the call's audit entry and updates the last failure. A failure to
   * write the entry is logged and never reaches the caller: the call has
   * already succeeded or failed on its own terms.
   *
   * The entry never holds the instructions, the input or the output. While a
   * promotion freezes the controller the write waits for the thaw, and once
   * the controller is sealed it is dropped, because the data has moved.
   */
  const recordCall = (
    call: TextGenerationCall,
    target: Exclude<TextGenerationTarget, { readonly _tag: "off" }>,
    attempt: Attempt,
    durationMs: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const { outcome } = attempt;
      const at = yield* nowIso;
      if (outcome._tag === "failed") {
        yield* lastFailure.record(target.failureKey, {
          reason: outcome.reason,
          message: outcome.message,
          at,
        });
      } else {
        yield* lastFailure.clear();
      }
      const { costUsd, ...tokens } = outcome._tag === "completed" ? (outcome.usage ?? {}) : {};
      yield* promotion.whenServingOr(
        audit.append({
          kind: outcome._tag === "completed" ? "textGeneration.completed" : "textGeneration.failed",
          actor: SYSTEM_ACTOR,
          payload: {
            purpose: `${readCallerId(call.caller)}/${call.purpose}`,
            caller: call.caller,
            instanceId: target._tag === "resolved" ? target.instance.id : null,
            model: target._tag === "resolved" ? target.model : null,
            runnerId: attempt.runnerId,
            durationMs,
            ...(outcome._tag === "failed"
              ? { reason: outcome.reason, message: outcome.message }
              : {}),
            ...(Object.keys(tokens).length === 0 ? {} : { usage: tokens }),
            ...(costUsd === undefined ? {} : { costUsd }),
          },
          at,
        }),
        () => Effect.void,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("A text generation could not be recorded", cause),
      ),
    );

  /**
   * Sends the call to the runner and waits for its answer, up to the
   * caller's deadline.
   *
   * The slot is not tied to the caller's wait. A fiber of this layer takes
   * the slot, sends the request and keeps the slot until the runner answers,
   * the connection ends, or `SLOT_HOLD_MS` passes. The runner always answers
   * within `TEXT_GENERATION_DEADLINE_MS` after it gets the request, so the
   * limit counts harnesses that are really running. If the caller's deadline
   * ended the slot instead, a burst during a provider outage would start new
   * harnesses on a runner whose old ones were still running.
   *
   * The caller's deadline starts when the call holds its slot, so the wait
   * for a slot does not count. A caller that is interrupted while still
   * queued withdraws: its fiber then takes the slot, sends nothing and lets
   * it go at once. A caller interrupted after the request was sent writes
   * no record; the fiber writes it once the runner answers, so the record
   * still holds the usage and cost of a call its caller gave up on.
   */
  const callRunner = (
    runnerId: string,
    target: ResolvedTarget,
    call: TextGenerationCall,
  ): Effect.Effect<Attempt> =>
    Effect.gen(function* () {
      const { instance, model } = target;
      const started = yield* Clock.currentTimeMillis;
      const decrypted = yield* Effect.result(
        readInstanceSecrets(secrets, yield* host.providers(), instance.id, instance.providerId),
      );
      if (decrypted._tag === "Failure") {
        const error = decrypted.failure;
        // A decryption failure names the secret, which is what the user must fix.
        return error._tag === "SecretDecryptError"
          ? buildFailedAttempt("failed", error.message, runnerId)
          : yield* Effect.die(error);
      }
      // Completed with the holder's whole exit, not only its answer, so a
      // defect in the holder reaches the caller at once, as its own defect.
      const answered = yield* Deferred.make<SendOutcome<Answer>>();
      // Completed once the holder has the slot, or once it ends, whichever
      // comes first, so a holder that ends early never leaves the caller waiting.
      const slotHeld = yield* Deferred.make<void>();
      const callerWaiting = yield* Ref.make(true);
      // Set only when the caller is interrupted, not when its deadline ends
      // the wait: a caller that times out writes its own record.
      const callerInterrupted = yield* Ref.make(false);
      /**
       * Writes the record of a request that was sent after all, once its
       * fiber ends, when the caller was interrupted and so wrote none. A
       * request the fiber never sent leaves no record.
       */
      const recordWhenCallerInterrupted = (
        exit: Exit.Exit<SendOutcome<Answer>>,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(callerInterrupted))) return;
          if (Exit.isSuccess(exit) && exit.value._tag === "notSent") return;
          const attempt = Exit.isSuccess(exit)
            ? decideAttempt(runnerId, call, exit.value)
            : buildFailedAttempt("failed", UNEXPECTED_FAILURE, runnerId);
          const ended = yield* Clock.currentTimeMillis;
          yield* recordCall(call, target, attempt, ended - started);
        });
      yield* FiberSet.run(
        slotHolders,
        getOrCreateRunnerSlots(runnerId)
          .withPermits(1)(
            Effect.flatMap(
              Effect.andThen(Deferred.succeed(slotHeld, undefined), Ref.get(callerWaiting)),
              (waiting) =>
                waiting
                  ? connections.sendRequest(
                      runnerId,
                      {
                        _tag: "textGenerationRequest",
                        requestId: crypto.randomUUID(),
                        instanceId: instance.id,
                        providerId: instance.providerId,
                        config: instance.config,
                        secrets: decrypted.success,
                        spec: {
                          model,
                          instructions: call.instructions,
                          input: call.input,
                          outputSchema: call.outputSchema,
                        },
                      },
                      Duration.millis(SLOT_HOLD_MS),
                    )
                  : // Nobody reads this: the caller has given up.
                    Effect.succeed<SendOutcome<Answer>>({ _tag: "notSent" }),
            ),
          )
          .pipe(
            Effect.onExit((exit) =>
              Effect.andThen(
                Effect.andThen(
                  Deferred.done(answered, exit),
                  Deferred.succeed(slotHeld, undefined),
                ),
                recordWhenCallerInterrupted(exit),
              ),
            ),
            // The exit now belongs to the caller. Ending the fiber with it as
            // well would only fail the fiber set nobody joins.
            Effect.ignoreCause,
          ),
      );
      const deadline = yield* TextGenerationDeadline;
      const sent = yield* Deferred.await(slotHeld).pipe(
        Effect.andThen(Effect.timeoutOption(Deferred.await(answered), deadline)),
        Effect.onInterrupt(() => Ref.set(callerInterrupted, true)),
        Effect.ensuring(Ref.set(callerWaiting, false)),
      );
      return Option.isNone(sent)
        ? buildFailedAttempt("timeout", TIMED_OUT, runnerId)
        : decideAttempt(runnerId, call, sent.value);
    });

  /**
   * Makes the call on the chosen target, and returns how it ended. A target
   * that cannot run, such as one with no runner able to take the call, ends
   * as a failed attempt with a message the user can act on.
   *
   * Only runners this controller holds a connection to are chosen. A runner
   * whose connection just ended can still be listed as online for a while,
   * and choosing it again would fail the same way while another runner could
   * answer.
   */
  const attemptCall = (
    target: Exclude<TextGenerationTarget, { readonly _tag: "off" }>,
    call: TextGenerationCall,
  ): Effect.Effect<Attempt> =>
    Effect.gen(function* () {
      if (target._tag === "unresolved" || target.runnerIds.length === 0) {
        return buildFailedAttempt("unavailable", explainTextGenerationUnavailable(target));
      }
      const connected = yield* Effect.filter(target.runnerIds, (id) =>
        connections.holdsConnection(id),
      );
      const runnerId = chooseRunner(connected);
      return runnerId === undefined
        ? buildFailedAttempt("unavailable", NOT_SENT)
        : yield* callRunner(runnerId, target, call);
    });

  return {
    generate: (call: TextGenerationCall): Effect.Effect<unknown, TextGenerationError> =>
      Effect.gen(function* () {
        if (
          call.instructions.length > MAX_TEXT_GENERATION_TEXT_LENGTH ||
          call.input.length > MAX_TEXT_GENERATION_TEXT_LENGTH
        ) {
          return yield* Effect.die(
            new Error(
              `a text generation carries at most ${String(MAX_TEXT_GENERATION_TEXT_LENGTH)} characters of instructions and of input; the caller must shorten them`,
            ),
          );
        }
        const issues = lintOutputSchema(call.outputSchema);
        // Workflow validation refuses such a schema, but a run's plan was
        // frozen under the rules of its day, so a step fails rather than
        // ending its run with a controller error.
        if (issues.length > 0) {
          return yield* Effect.fail(
            new TextGenerationError({
              reason: "failed",
              message: `the output schema is outside the JSON Schema subset every provider accepts: ${issues.join("; ")}`,
            }),
          );
        }

        // A database error here is not recorded: the audit entry is written
        // to the same database.
        const target = yield* Effect.orDie(models.resolve());
        if (target._tag === "off") {
          return yield* Effect.fail(
            new TextGenerationError({
              reason: "unavailable",
              message: explainTextGenerationUnavailable(target),
            }),
          );
        }

        const started = yield* Clock.currentTimeMillis;
        const attempt: Attempt = yield* attemptCall(target, call).pipe(
          // Every call writes one record, so an error nobody expected is
          // recorded as failed, and then passed on to be logged. An
          // interruption is not an error: the controller is stopping.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.andThen(
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((ended) =>
                      recordCall(
                        call,
                        target,
                        buildFailedAttempt("failed", UNEXPECTED_FAILURE),
                        ended - started,
                      ),
                    ),
                  ),
                  Effect.failCause(cause),
                ),
          ),
        );
        const durationMs = (yield* Clock.currentTimeMillis) - started;
        yield* recordCall(call, target, attempt, durationMs);

        return attempt.outcome._tag === "completed"
          ? attempt.outcome.value
          : yield* Effect.fail(
              new TextGenerationError({
                reason: attempt.outcome.reason,
                message: attempt.outcome.message,
              }),
            );
      }),
  };
});

export const TextGenerationLayer: Layer.Layer<
  TextGeneration,
  never,
  | SqlClient.SqlClient
  | TextGenerationModels
  | LastTextGenerationFailure
  | RunnerConnections
  | Secrets
  | PluginHost
  | AuditLog
  | PromotionState
  | LocalRunnerId
> = Layer.effect(TextGeneration)(make);
