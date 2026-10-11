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
  createValidationError,
  HAND_TO_ACTION_PREFIX,
  listSchemaIssues,
  MAX_SIGNAL_BYTES,
  Signal,
  Validation,
  type BoundAction,
  type Issue,
  type WorkflowDefinition,
} from "@hercule/contract";
import { BoundOperations } from "../bound-actions";

/**
 * Returns one Hand to an agent action for each workflow that has a signal
 * input accepting `kind`. Each binds `run.start` with the signal's id as the
 * first such input. A proposal gets none: a workflow input cannot accept
 * `proposal`, so work always keeps its Task.
 *
 * A workflow with another required input that has no default is left out.
 * The action fills only the signal input, so `run.start` would refuse its
 * click.
 */
export const buildHandToActions = (
  signalId: string,
  kind: string,
  workflows: ReadonlyArray<{ readonly id: string; readonly definition: WorkflowDefinition }>,
): ReadonlyArray<BoundAction> =>
  workflows.flatMap(({ id, definition }) => {
    const inputs = definition.inputs ?? [];
    const input = inputs.find((declared) => declared.signal?.kinds.includes(kind));
    const needsMore = inputs.some(
      (declared) => declared !== input && declared.required && declared.default === undefined,
    );
    return input === undefined || needsMore
      ? []
      : [
          {
            id: `${HAND_TO_ACTION_PREFIX}${id}`,
            label: `Hand to ${definition.name}`,
            operation: {
              op: "run.start",
              input: { workflowId: id, inputs: { [input.name]: signalId } },
            },
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
