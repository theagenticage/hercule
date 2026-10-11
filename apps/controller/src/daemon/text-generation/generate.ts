/**
 * Makes text generations: picks the runner, sends the call, waits for the
 * answer and writes the record. The `TextGeneration` interface in
 * `service.ts` says what a caller gets; this file is how it is done.
 *
 * Nothing durable is created for a call but its audit entry. A call lost to a
 * restart leaves nothing behind.
 */
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { TextGenerationFailureReason } from "@hercule/contract";
import {
  lintOutputSchema,
  MAX_TEXT_GENERATION_TEXT_LENGTH,
  TEXT_GENERATION_CAPABILITY,
  TEXT_GENERATION_DEADLINE_MS,
  type OutputSchema,
  type Usage,
} from "@hercule/protocol";
import { SYSTEM_ACTOR } from "../../actor";
import { nowIso } from "../../db";
import { AuditLog } from "../../events";
import { deriveCatalogJsonSchema, PluginHost } from "../../plugins";
import { isLoggedIn, providerRepository, type StoredInstance } from "../../providers";
import { PromotionState } from "../../promotion";
import { LocalRunnerId, RunnerConnections, runnerRepository } from "../../runners";
import { readInstanceSecrets, Secrets } from "../../secrets";
import { LastTextGenerationFailure, TextGenerationModels } from "../../text-generation";
import {
  TextGeneration,
  TextGenerationError,
  type TextGenerationCaller,
  type TextGenerationRequest,
} from "./service";

/**
 * How many text generations one runner makes at once. It only guards against
 * a stampede, such as a burst of fifty events each asking for a summary, so
 * normal use never reaches it. It is separate from `maxConcurrentSessions`,
 * because a text generation is not a Session and takes no session slot.
 */
export const MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER = 10;

/**
 * The runner stops the harness at `TEXT_GENERATION_DEADLINE_MS`. The
 * controller waits a little longer, so the runner's own answer ("the harness
 * ran past its deadline") arrives before this wait gives up.
 */
const DEADLINE_SLACK_MS = 5_000;

/**
 * How long a call waits for a free slot on its runner and for the runner's
 * answer, together. Tests override it with a shorter one.
 */
export const TextGenerationDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/TextGenerationDeadline",
  {
    defaultValue: (): Duration.Duration =>
      Duration.millis(TEXT_GENERATION_DEADLINE_MS + DEADLINE_SLACK_MS),
  },
);

const NO_ANSWER_IN_TIME =
  "the text generation did not finish in time; the runner may be busy or not answering";

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

const failed = (
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
  const instances = yield* providerRepository;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const secrets = yield* Secrets;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;
  const promotion = yield* PromotionState;
  const localRunnerId = yield* LocalRunnerId;

  // One semaphore per runner, created the first time a call lands on it. They
  // live in memory only: after a restart no call is in flight.
  const semaphores = new Map<string, Semaphore.Semaphore>();
  const limitFor = (runnerId: string): Semaphore.Semaphore => {
    const existing = semaphores.get(runnerId);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER);
    semaphores.set(runnerId, created);
    return created;
  };

  /**
   * Chooses the runner for the instance: the local runner if the instance is
   * logged in there, otherwise the logged-in runner with the lowest id. Only
   * a runner that is placeable (online, active, not reserved) and has
   * negotiated the text generation capability qualifies. Returns the runner's
   * id, or the message that says why there is none.
   */
  const chooseRunner = (
    instance: StoredInstance,
  ): Effect.Effect<{ readonly runnerId: string } | { readonly message: string }> =>
    Effect.gen(function* () {
      const loggedIn = new Set(
        (yield* instances.listSnapshots(instance.id)).filter(isLoggedIn).map((one) => one.runnerId),
      );
      const local = localRunnerId.read();
      const eligible = (yield* runners.listPlacementCandidates())
        .filter((one) => one.placeable && loggedIn.has(one.id))
        .sort(
          (a, b) => Number(b.id === local) - Number(a.id === local) || a.id.localeCompare(b.id),
        );
      if (eligible.length === 0) {
        return {
          message: `no connected runner is logged in to the provider instance ${instance.name}; log in on a machine first`,
        };
      }
      const capable = eligible.find((one) => one.capabilities.includes(TEXT_GENERATION_CAPABILITY));
      return capable === undefined
        ? {
            message: `no runner that is logged in to the provider instance ${instance.name} can make text generations; update the runner`,
          }
        : { runnerId: capable.id };
    }).pipe(Effect.orDie);

  /**
   * Sends the call to the runner and waits for its answer. The wait for a
   * free slot is inside the deadline, so a call that queues behind a
   * stampede times out like any other.
   */
  const callRunner = <A>(
    runnerId: string,
    instance: StoredInstance,
    model: string,
    request: TextGenerationRequest<A>,
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
          ? failed("unavailable", error.message, runnerId)
          : yield* Effect.die(error);
      }
      const answer = yield* Effect.timeoutOption(
        limitFor(runnerId).withPermits(1)(
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
                model: { model, options: {} },
                instructions: request.instructions,
                input: request.input,
                outputSchema,
              },
            },
            // The deadline below ends the wait, so the connection ending is
            // the only other way for it to stop.
            Duration.infinity,
          ),
        ),
        yield* TextGenerationDeadline,
      );
      if (Option.isNone(answer)) return failed("timeout", NO_ANSWER_IN_TIME, runnerId);
      if (Option.isNone(answer.value) || answer.value.value._tag !== "textGenerationReport") {
        return failed("unavailable", "the runner's connection ended before it answered", runnerId);
      }
      const reported = answer.value.value.outcome;
      switch (reported.outcome) {
        case "failed":
          return failed("unavailable", reported.message, runnerId);
        case "invalid-output":
          // The reason is left out on purpose: it can quote the model's output,
          // and the record and the status must never hold it.
          return failed(
            "invalid-output",
            "the model's answer did not match the output schema",
            runnerId,
          );
        case "ok":
          return yield* Effect.match(Schema.decodeUnknownEffect(request.output)(reported.value), {
            onFailure: () =>
              failed(
                "invalid-output",
                "the model's answer did not match the output schema",
                runnerId,
              ),
            onSuccess: (value): Attempt<A> => ({
              runnerId,
              outcome: { _tag: "completed", value, usage: reported.usage },
            }),
          });
      }
    });

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
    request: TextGenerationRequest<A>,
    chosen: { readonly instanceId: string; readonly model: string } | null,
    attempt: Attempt<A>,
    durationMs: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const { outcome } = attempt;
      const at = yield* nowIso;
      if (outcome._tag === "failed") {
        yield* lastFailure.record({ reason: outcome.reason, message: outcome.message, at });
      } else {
        yield* lastFailure.clear();
      }
      const { costUsd, ...tokens } = outcome._tag === "completed" ? (outcome.usage ?? {}) : {};
      yield* promotion.whenServingOr(
        audit.append({
          kind: outcome._tag === "completed" ? "textGeneration.completed" : "textGeneration.failed",
          actor: SYSTEM_ACTOR,
          payload: {
            purpose: `${readCallerId(request.caller)}/${request.purpose}`,
            caller: request.caller,
            instanceId: chosen?.instanceId ?? null,
            model: chosen?.model ?? null,
            runnerId: attempt.runnerId,
            durationMs,
            outcome: outcome._tag === "completed" ? "completed" : outcome.reason,
            ...(outcome._tag === "failed" ? { message: outcome.message } : {}),
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
    generate: <A>(request: TextGenerationRequest<A>): Effect.Effect<A, TextGenerationError> =>
      Effect.gen(function* () {
        if (
          request.instructions.length > MAX_TEXT_GENERATION_TEXT_LENGTH ||
          request.input.length > MAX_TEXT_GENERATION_TEXT_LENGTH
        ) {
          return yield* Effect.die(
            new Error(
              `a text generation carries at most ${String(MAX_TEXT_GENERATION_TEXT_LENGTH)} characters of instructions and of input; the caller must shorten them`,
            ),
          );
        }
        const derived = deriveCatalogJsonSchema(request.output);
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

        const choice = yield* Effect.orDie(models.resolve());
        if (choice._tag === "off") {
          return yield* Effect.fail(
            new TextGenerationError({ reason: "unavailable", message: "text generation is off" }),
          );
        }

        const started = yield* Clock.currentTimeMillis;
        let chosen: { readonly instanceId: string; readonly model: string } | null = null;
        const attempt: Attempt<A> =
          choice._tag === "unresolved"
            ? failed("unavailable", choice.message)
            : yield* Effect.gen(function* () {
                chosen = { instanceId: choice.instanceId, model: choice.model };
                const found = yield* Effect.orDie(instances.one(choice.instanceId));
                if (Option.isNone(found)) {
                  return failed(
                    "unavailable",
                    "the provider instance for text generation no longer exists",
                  );
                }
                const runner = yield* chooseRunner(found.value);
                return "message" in runner
                  ? failed("unavailable", runner.message)
                  : yield* callRunner(
                      runner.runnerId,
                      found.value,
                      choice.model,
                      request,
                      outputSchema,
                    );
              });
        const durationMs = (yield* Clock.currentTimeMillis) - started;
        yield* recordCall(request, chosen, attempt, durationMs);

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
