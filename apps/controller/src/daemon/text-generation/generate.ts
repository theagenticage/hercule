/**
 * Makes text generations: picks the runner, sends the call, waits for the
 * answer and writes the record. The `TextGeneration` interface in
 * `service.ts` describes what a caller gets; this file is how it is done.
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
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { TextGenerationFailureReason } from "@hercule/contract";
import {
  lintOutputSchema,
  MAX_TEXT_GENERATION_TEXT_LENGTH,
  TEXT_GENERATION_DEADLINE_MS,
  type OutputSchema,
  type Usage,
} from "@hercule/protocol";
import { SYSTEM_ACTOR } from "../../actor";
import { nowIso } from "../../db";
import { AuditLog } from "../../events";
import { deriveCatalogJsonSchema, PluginHost } from "../../plugins";
import type { StoredInstance } from "../../providers";
import { PromotionState } from "../../promotion";
import { LocalRunnerId, RunnerConnections, type Answer } from "../../runners";
import { readInstanceSecrets, Secrets } from "../../secrets";
import {
  LastTextGenerationFailure,
  TextGenerationModels,
  type TextGenerationTarget,
} from "../../text-generation";
import {
  TextGeneration,
  TextGenerationError,
  type TextGenerationCall,
  type TextGenerationCaller,
} from "./service";

/**
 * How many text generations one runner makes at once. It only guards against
 * a stampede, such as a burst of fifty events each asking for a summary, so
 * normal use never reaches it. It is separate from `maxConcurrentSessions`,
 * because a text generation is not a Session and takes no session slot.
 */
const MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER = 10;

/**
 * How long a call holds its slot, at most, after the request is sent. The
 * runner stops its harness at `TEXT_GENERATION_DEADLINE_MS` and then answers,
 * so the slot normally frees just after that. The extra time covers the
 * answer travelling back. It also bounds the hold for a runner that breaks
 * its promise to answer, so such a runner cannot keep slots for good.
 */
const SLOT_HOLD_MS = TEXT_GENERATION_DEADLINE_MS + 5_000;

/**
 * How long a caller waits, in all: for a free slot on the runner, and then
 * for the runner's answer. A caller that gives up at this deadline gets a
 * `timeout` error, but its call keeps its slot until the runner answers (see
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

const UNEXPECTED_FAILURE =
  "the text generation stopped on an unexpected error; the controller log has the details";

/** How a call ended, before it is turned into a value or an error. */
type Outcome<A> =
  | { readonly _tag: "completed"; readonly value: A; readonly usage: Usage | null }
  | {
      readonly _tag: "failed";
      readonly reason: TextGenerationFailureReason;
      readonly message: string;
    };

/** An outcome, and the runner it came from, which is null when no runner was chosen. */
interface Attempt<A> {
  readonly runnerId: string | null;
  readonly outcome: Outcome<A>;
}

/**
 * Builds the attempt of a call that failed. The message must not be empty:
 * the last failure and the error both require one. The protocol already
 * refuses an empty message from a runner.
 */
const buildFailedAttempt = (
  reason: TextGenerationFailureReason,
  message: string,
  runnerId: string | null = null,
): Attempt<never> => ({ runnerId, outcome: { _tag: "failed", reason, message } });

/** Removes the `core:` or `plugin:` prefix, which the record keeps as the caller. */
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
   * The caller's deadline covers the wait for a slot too. A caller that gives
   * up while still queued withdraws: its fiber then takes no slot to use.
   */
  const callRunner = <A>(
    runnerId: string,
    instance: StoredInstance,
    model: string,
    call: TextGenerationCall<A>,
    outputSchema: OutputSchema,
  ): Effect.Effect<Attempt<A>> =>
    Effect.gen(function* () {
      const decrypted = yield* Effect.result(
        readInstanceSecrets(secrets, yield* host.providers(), instance.id, instance.providerId),
      );
      if (decrypted._tag === "Failure") {
        const error = decrypted.failure;
        // A decryption failure names the secret, which is what the user must fix.
        return error._tag === "SecretDecryptError"
          ? buildFailedAttempt("unavailable", error.message, runnerId)
          : yield* Effect.die(error);
      }
      const answered = yield* Deferred.make<Option.Option<Answer>>();
      const callerWaiting = yield* Ref.make(true);
      yield* FiberSet.run(
        slotHolders,
        getOrCreateRunnerSlots(runnerId).withPermits(1)(
          Effect.flatMap(Ref.get(callerWaiting), (waiting) =>
            waiting
              ? Effect.flatMap(
                  connections.asked(
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
                        outputSchema,
                      },
                    },
                    Duration.millis(SLOT_HOLD_MS),
                  ),
                  (answer) => Deferred.succeed(answered, answer),
                )
              : Effect.void,
          ),
        ),
      );
      const answer = yield* Effect.timeoutOption(
        Deferred.await(answered),
        yield* TextGenerationDeadline,
      ).pipe(Effect.ensuring(Ref.set(callerWaiting, false)));
      if (Option.isNone(answer)) return buildFailedAttempt("timeout", TIMED_OUT, runnerId);
      if (Option.isNone(answer.value) || answer.value.value._tag !== "textGenerationReport") {
        return buildFailedAttempt("unavailable", CONNECTION_ENDED, runnerId);
      }
      const reported = answer.value.value.outcome;
      switch (reported.outcome) {
        case "failed":
          return buildFailedAttempt("unavailable", reported.message, runnerId);
        case "timeout":
          return buildFailedAttempt("timeout", TIMED_OUT, runnerId);
        case "invalid-output":
          // The reason is left out on purpose: it can quote the model's output,
          // and the record and the status must never hold it.
          return buildFailedAttempt("invalid-output", INVALID_OUTPUT, runnerId);
        case "ok":
          return yield* Effect.match(Schema.decodeUnknownEffect(call.output)(reported.value), {
            onFailure: () => buildFailedAttempt("invalid-output", INVALID_OUTPUT, runnerId),
            onSuccess: (value): Attempt<A> => ({
              runnerId,
              outcome: { _tag: "completed", value, usage: reported.usage },
            }),
          });
      }
    });

  /**
   * Makes the call on the chosen target, and returns how it ended. A target
   * that cannot run, such as one with no runner able to take the call, ends
   * as a failed attempt with a message the user can act on.
   */
  const attemptCall = <A>(
    target: Exclude<TextGenerationTarget, { readonly _tag: "off" }>,
    call: TextGenerationCall<A>,
    outputSchema: OutputSchema,
  ): Effect.Effect<Attempt<A>> => {
    if (target._tag === "unresolved") {
      return Effect.succeed(buildFailedAttempt("unavailable", target.message));
    }
    const runnerId = chooseRunner(target.runnerIds);
    return runnerId === undefined
      ? Effect.succeed(
          buildFailedAttempt(
            "unavailable",
            `no connected runner that can make text generations is logged in to the provider instance ${target.instance.name} with the model ${target.model}; log in on a machine, or update its runner`,
          ),
        )
      : callRunner(runnerId, target.instance, target.model, call, outputSchema);
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
  const recordCall = <A>(
    call: TextGenerationCall<A>,
    target: Exclude<TextGenerationTarget, { readonly _tag: "off" }>,
    attempt: Attempt<A>,
    durationMs: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const { outcome } = attempt;
      const at = yield* nowIso;
      if (outcome._tag === "failed") {
        yield* lastFailure.record(target.setting, {
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

  return {
    generate: <A>(call: TextGenerationCall<A>): Effect.Effect<A, TextGenerationError> =>
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
        const derived = deriveCatalogJsonSchema(call.output);
        const issues = lintOutputSchema(derived);
        if (issues.length > 0) {
          return yield* Effect.die(
            new Error(
              `the output schema of a text generation is outside the JSON Schema subset every provider accepts: ${issues.join("; ")}`,
            ),
          );
        }
        // Lint accepted it, so it is a closed JSON object schema.
        const outputSchema = derived as OutputSchema;

        // A database error here is not recorded: the audit entry is written
        // to the same database.
        const target = yield* Effect.orDie(models.resolve());
        if (target._tag === "off") {
          return yield* Effect.fail(
            new TextGenerationError({ reason: "unavailable", message: "text generation is off" }),
          );
        }

        const started = yield* Clock.currentTimeMillis;
        const attempt: Attempt<A> = yield* attemptCall(target, call, outputSchema).pipe(
          // Every call writes one record, so an error nobody expected is
          // recorded as unavailable, and then passed on to be logged. An
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
                        buildFailedAttempt("unavailable", UNEXPECTED_FAILURE),
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
