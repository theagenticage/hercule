/**
 * Pure helpers for the values a session starts with:
 *
 * - validating the model options a caller picked,
 * - the timeouts a session runs under,
 * - the spec for a session that continues another session's transcript.
 *
 * The caller reads the model catalog, the settings and the row and passes
 * them in, so these rules live in one place and have no dependencies.
 */
import * as Effect from "effect/Effect";
import type { ModelDescriptor, ModelSelection, SessionSpec } from "@hercule/protocol";
import { createValidationError, type Validation } from "@hercule/contract";
import type { ScopeSettings } from "../settings";

/** The model options a caller picked, as the row and the wire store them. */
export type ModelOptions = ModelSelection["options"];

/**
 * Checks that the model offers every option in `given`, with a valid value.
 * Fails with a `Validation` error that lists every invalid option, not just
 * the first, so a caller fixing a form sees all the problems at once.
 *
 * A model with no descriptor in the catalog offers no options, so every option
 * sent with it is rejected. That is how an unknown model slug is caught here,
 * even though the runner is the one that rejects the slug itself.
 */
export const validateOptions = (
  models: ReadonlyArray<ModelDescriptor>,
  model: string,
  given: ModelOptions,
): Effect.Effect<void, Validation> => {
  const described = models.find((one) => one.slug === model);
  const issues = Object.entries(given).flatMap(([id, value]) => {
    const at = { path: ["options", id] };
    if (described === undefined) {
      return [{ ...at, message: `the runner reported no descriptor for ${model}` }];
    }
    const option = described.options.find((one) => one.id === id);
    if (option === undefined) return [{ ...at, message: `${model} has no option named ${id}` }];
    if (option.kind === "boolean") {
      return typeof value === "boolean" ? [] : [{ ...at, message: `${id} must be true or false` }];
    }
    const choices = (option.choices ?? []).map((choice) => choice.value);
    return typeof value === "string" && choices.includes(value)
      ? []
      : [{ ...at, message: `${id} must be one of ${choices.join(", ")}` }];
  });
  return issues.length === 0 ? Effect.void : Effect.fail(createValidationError(issues));
};

/** Used when the settings key is unset. The controller applies it; the runner has no default of its own. */
const DEFAULT_INACTIVITY_TIMEOUT_MINUTES = 30;

const DEFAULT_ABSOLUTE_TIMEOUT_MINUTES = 480;

const MINUTE_MS = 60_000;

/**
 * The absolute timeout for a session whose stored spec has none, because it
 * was stored before the spec had timeouts. It is the same default as above.
 */
export const DEFAULT_ABSOLUTE_TIMEOUT_MS = DEFAULT_ABSOLUTE_TIMEOUT_MINUTES * MINUTE_MS;

/** Returns the two timeouts a session starts with, converted from minutes in the settings to milliseconds for the wire. */
export const buildTimeouts = (
  controller: ScopeSettings<"controller">,
): SessionSpec["timeouts"] => ({
  inactivityMs:
    (controller["session.inactivityTimeoutMinutes"] ?? DEFAULT_INACTIVITY_TIMEOUT_MINUTES) *
    MINUTE_MS,
  absoluteMs:
    (controller["session.absoluteTimeoutMinutes"] ?? DEFAULT_ABSOLUTE_TIMEOUT_MINUTES) * MINUTE_MS,
});

const DEFAULT_IDLE_UNLOAD_MINUTES = 15;

/**
 * Returns the timeouts a session that answers an assistant's conversation
 * starts with: the two every session has, plus the idle unload. A
 * conversation session sits idle between the owner's messages for hours, and
 * unloading its process saves the runner's memory; the next message resumes
 * it. A Thread is never unloaded, because unloading its process would also
 * end any background process it started, such as a dev server.
 */
export const buildConversationTimeouts = (
  controller: ScopeSettings<"controller">,
): SessionSpec["timeouts"] => ({
  ...buildTimeouts(controller),
  idleMs: (controller["session.idleUnloadMinutes"] ?? DEFAULT_IDLE_UNLOAD_MINUTES) * MINUTE_MS,
});

/**
 * How long a workflow run's step session may sit idle before its runner
 * unloads it. It is a few seconds rather than none, so that a step prompt
 * already on its way, such as the next iteration's, reaches the session
 * before it goes.
 */
const STEP_SESSION_IDLE_UNLOAD_MS = 5_000;

/**
 * Returns the timeouts a session that runs a workflow run's agent step starts
 * with: the two every session has, plus an idle unload of five seconds.
 *
 * Once the step's turn ends, the run may not prompt the session again for
 * days, or ever: the next iteration may wait on a signal, or never come. An
 * idle session still counts against its runner's session cap, so without the
 * unload a later step of the same run could wait forever for the slot a
 * finished step holds, and the process would keep its memory all that time.
 * The next iteration's prompt resumes the unloaded session in place. Any
 * background process the agent left running ends with the unload.
 */
export const buildStepSessionTimeouts = (
  controller: ScopeSettings<"controller">,
): SessionSpec["timeouts"] => ({
  ...buildTimeouts(controller),
  idleMs: STEP_SESSION_IDLE_UNLOAD_MS,
});

/**
 * Builds the spec sent to a runner for a session that continues a
 * provider-native session, either resumed in place or forked. Returns the
 * parent's spec with three changes: the model selection the parent ended on,
 * the native session to continue from, and the timeouts from the current
 * settings. `session` holds the conversation the continuing session answers
 * and the run it runs a step of, each `null` when there is none. They decide
 * the timeouts:
 *
 * - a session that answers a conversation gets the conversation timeouts;
 * - a session that runs a step gets the step session timeouts;
 * - any other session gets the two every session has.
 *
 * It copies the parent's whole spec rather than picking named fields, so
 * everything an Agent gave the parent also reaches the continuation: the
 * prompt, the disallowed tools, and the output schema. The Agent is not read
 * again, because it may have been edited since the parent was spawned: a
 * session's own spec is the record of what shaped it (ADR 0030). A fork that
 * ran under a different prompt than its parent would be a different piece of
 * work.
 */
export const buildContinuingSpec = (
  parent: SessionSpec,
  controller: ScopeSettings<"controller">,
  modelSelection: ModelSelection,
  nativeSessionId: string,
  mode: NonNullable<SessionSpec["continue"]>["mode"],
  session: { readonly conversationId: string | null; readonly runId: string | null },
): SessionSpec => ({
  ...parent,
  modelSelection,
  continue: { nativeSessionId, mode },
  timeouts:
    session.conversationId !== null
      ? buildConversationTimeouts(controller)
      : session.runId !== null
        ? buildStepSessionTimeouts(controller)
        : buildTimeouts(controller),
});
