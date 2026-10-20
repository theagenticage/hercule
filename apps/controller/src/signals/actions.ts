/**
 * The parts of raising a signal that `signal.raise` and the signal raise
 * step share: the core's Hand to an agent actions, the checks of the
 * raiser's own actions, and the check that the finished signal fits the
 * contract.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  countJsonBytes,
  DISMISS_ACTION_ID,
  createValidationError,
  HAND_TO_ACTION_PREFIX,
  listSchemaIssues,
  MAX_SIGNAL_BYTES,
  Signal,
  Validation,
  type AnswerOperationId,
  type BoundAction,
  type Issue,
  type WorkflowDefinition,
} from "@hercule/contract";
import { BoundOperations } from "../bound-actions";

/** The core's Dismiss: an action that takes the signal off the list and runs nothing. */
export const DISMISS_ACTION: BoundAction = {
  id: DISMISS_ACTION_ID,
  label: "Dismiss",
  operation: null,
};

/**
 * The operations only the core binds on a signal, each with the refusal a
 * raiser that binds it gets. The user's click runs an action as the user, so
 * a raiser that could bind `ignoreRule.create` could hide signals from the
 * user under any label. The core binds it on its own Ignore Rule offer only.
 */
const CORE_ONLY_OPERATIONS: ReadonlyMap<string, string> = new Map([
  [
    "ignoreRule.create" satisfies AnswerOperationId<"signal.answer">,
    "An action cannot run ignoreRule.create: only the core binds it, on the offer it raises after the user marked five signals of one group done in a row. A rule hides signals from the user, and the click would create it as the user. To suggest a rule, describe it in the signal; the user creates it from Intake.",
  ],
]);

/**
 * Returns the first input of a workflow that takes signals of `kind`, or
 * `undefined` when it has none. A Hand to an agent action fills this input
 * with the signal's id.
 */
export const findSignalInput = (definition: WorkflowDefinition, kind: string) =>
  (definition.inputs ?? []).find((declared) => declared.signal?.kinds.includes(kind));

/**
 * Returns one Hand to an agent action for each workflow that has a signal
 * input accepting `kind`. Each binds `signal.handOff`, which fills the first
 * such input with the signal's id. A proposal gets none: a workflow input
 * cannot accept `proposal`, so work always keeps its Task.
 *
 * A workflow with another required input that has no default is left out.
 * The handoff fills only the signal input, so `run.start` would refuse its
 * click.
 */
export const buildHandToActions = (
  signalId: string,
  kind: string,
  workflows: ReadonlyArray<{ readonly id: string; readonly definition: WorkflowDefinition }>,
): ReadonlyArray<BoundAction> =>
  workflows.flatMap(({ id, definition }) => {
    const input = findSignalInput(definition, kind);
    const needsMore = (definition.inputs ?? []).some(
      (declared) => declared !== input && declared.required && declared.default === undefined,
    );
    return input === undefined || needsMore
      ? []
      : [
          {
            id: `${HAND_TO_ACTION_PREFIX}${id}`,
            label: `Hand to ${definition.name}`,
            operation: { op: "signal.handOff", input: { signalId, workflowId: id } },
          },
        ];
  });

/**
 * Lists what would make the signal's actions ambiguous once the core adds its
 * own. The user picks an action by its label, and a client takes it by its
 * id, so the list holds an issue for:
 *
 * - a raiser's action with the id or the label of a core action;
 * - a raiser's action with the id or the label of an earlier raiser's action;
 * - more than one action marked primary, because the design shows one
 *   suggested action at most.
 *
 * Returns an empty list when the actions are unambiguous.
 */
export const listActionIssues = (
  own: ReadonlyArray<BoundAction>,
  core: ReadonlyArray<BoundAction>,
): ReadonlyArray<Issue> => {
  const issues: Array<Issue> = [];
  for (const [index, action] of own.entries()) {
    const path = ["actions", String(index)];
    const clash = core.find(
      (coreAction) => coreAction.id === action.id || coreAction.label === action.label,
    );
    if (clash !== undefined) {
      issues.push({
        path,
        message: `The core adds its own "${clash.label}" action (id ${clash.id}) to this signal. Give your action another id and label.`,
      });
      continue;
    }
    const earlier = own
      .slice(0, index)
      .find((other) => other.id === action.id || other.label === action.label);
    if (earlier !== undefined) {
      issues.push({
        path,
        message: `Another action already has the id ${JSON.stringify(earlier.id)} or the label ${JSON.stringify(earlier.label)}. Give each action its own id and label.`,
      });
    }
  }
  if ([...own, ...core].filter((action) => action.primary === true).length > 1) {
    issues.push({
      path: ["actions"],
      message: "More than one action is marked primary. Mark at most one.",
    });
  }
  return issues;
};

/**
 * Checks the raiser's own actions before they are stored on a signal:
 *
 * - none is ambiguous beside the core's actions (`listActionIssues`);
 * - none binds an operation only the core binds (`CORE_ONLY_OPERATIONS`);
 * - each one's operation passes the `BoundOperations` check for a signal's
 *   answer;
 * - a typed reply sits only on an action with an operation.
 *
 * Returns every issue found, or an empty list. Fails only on a database
 * error.
 */
export const listOwnActionIssues = (
  own: ReadonlyArray<BoundAction>,
  core: ReadonlyArray<BoundAction>,
): Effect.Effect<ReadonlyArray<Issue>, SqlError, BoundOperations> =>
  Effect.gen(function* () {
    const operations = yield* BoundOperations;
    const issues: Array<Issue> = [...listActionIssues(own, core)];
    for (const [index, action] of own.entries()) {
      const path = ["actions", String(index)];
      if (action.operation === null) {
        if (action.field !== undefined) {
          issues.push({
            path: [...path, "field"],
            message:
              "A typed reply fills the input of the action's operation, and this action has none. Leave out field.",
          });
        }
        continue;
      }
      const coreOnly = CORE_ONLY_OPERATIONS.get(action.operation.op);
      if (coreOnly !== undefined) {
        issues.push({ path: [...path, "operation", "op"], message: coreOnly });
        continue;
      }
      const refusal = yield* operations
        .check("signal.answer", action.operation, action.field, path)
        .pipe(
          Effect.as(undefined),
          Effect.catchIf(
            (error) => error instanceof Validation,
            (error) => Effect.succeed(error),
          ),
        );
      if (refusal !== undefined) issues.push(...refusal.error.details.issues);
    }
    return issues;
  });

const decodeSignal = Schema.decodeUnknownEffect(Signal, { errors: "all" });

/**
 * Checks that a finished signal fits the contract: the `Signal` schema, and
 * at most `MAX_SIGNAL_BYTES` of JSON. Returns the signal, typed. Fails with
 * `Validation` listing every problem found.
 */
export const checkSignalFits = (candidate: unknown): Effect.Effect<Signal, Validation> =>
  Effect.gen(function* () {
    const signal = yield* Effect.mapError(decodeSignal(candidate), (error) =>
      createValidationError(listSchemaIssues(error.issue)),
    );
    if (countJsonBytes(signal) > MAX_SIGNAL_BYTES) {
      return yield* Effect.fail(
        createValidationError([
          { path: [], message: `the signal is larger than ${MAX_SIGNAL_BYTES} bytes of JSON` },
        ]),
      );
    }
    return signal;
  });
