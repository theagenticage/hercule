/**
 * The signal operations: `signal.query`, `read`, `raise`, `act` and
 * `withdraw`.
 *
 * A signal is what Intake puts in front of the user because a move is asked
 * of them. This service raises the core's four kinds (`proposal`, `offer`,
 * `unsure` and `fyi`) for any actor that holds `signal.write`, and lays out
 * the core's own actions beside the raiser's:
 *
 * - a proposal gets Accept, which creates its task, and Dismiss;
 * - an offer gets Dismiss;
 * - an fyi gets Done;
 * - an offer, an unsure and an fyi get one Hand to an agent action per
 *   enabled workflow with a signal input that accepts the kind.
 *
 * Only the user takes an action, through `act`. Each action's operation is
 * checked, run and described through the `BoundOperations` port, which the
 * controller daemon implements. Spec 10 §9 owns the rules.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  ACCEPT_ACTION_ID,
  countJsonBytes,
  createForbiddenError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  DISMISS_ACTION_ID,
  DONE_ACTION_ID,
  HAND_TO_ACTION_PREFIX,
  listSchemaIssues,
  MAX_BOUND_INPUT_BYTES,
  Signal,
  Validation,
  type BoundAction,
  type CoreSignalKind,
  type DescribeLine,
  type Forbidden,
  type Id,
  type InvalidState,
  type Issue,
  type NotFound,
  type SignalAction,
  type SignalActInput,
  type SignalFilter,
  type SignalOrigin,
  type SignalRaiseInput,
  type SignalRaiseResult,
  type SignalResolution,
  type SignalWithdrawInput,
  type Unauthenticated,
  type WorkflowDefinition,
} from "@hercule/contract";
import {
  buildActorStamp,
  buildResolutionOrigin,
  requireGrant,
  requireUserActor,
  type Actor,
  type UserActor,
} from "../actor";
import {
  BoundOperations,
  isPluginAnswerOperation,
  type BoundOperationError,
  type CheckedOperation,
} from "../bound-actions";
import { mintUuid, nowIso, uuidToString, withTransaction } from "../db";
import { AuditLog } from "../events";
import { runRepository } from "../runs";
import { sessionRepository } from "../sessions";
import { workflowRepository } from "../workflows";
import { signalRepository } from "./repository";

/** The input of `signal.act`: the signal's id, the action to take and its typed reply. */
export interface ActInput extends SignalActInput {
  readonly id: Id;
}

/** The input of `signal.withdraw`: the signal's id and the reason. */
export interface WithdrawInput extends SignalWithdrawInput {
  readonly id: Id;
}

const NO_SUCH_SIGNAL = "no such signal";

/** The describe line of an action that runs nothing. */
const NO_OPERATION_DESCRIBE_LINE: DescribeLine = [{ kind: "text", text: "Does nothing" }];

/**
 * The describe line of the core's Done on a core kind. A plugin's kind adds
 * which source is not told; a core kind has no source to tell.
 */
const DONE_DESCRIBE_LINE: DescribeLine = [{ kind: "text", text: "Takes it off your list" }];

/**
 * The refusal for a caller who is not the user taking an action. A session
 * may hold `signal.write`, the grant this operation checks, so the message
 * says why the grant does not help.
 */
const ONLY_THE_USER =
  "only the user may take a signal's action: it runs its operation as the user, so a session or a workflow step may not take one; ask the user instead";

const ALREADY_RESOLVED = "the signal is already resolved, so its actions can no longer be taken";

/** The refusal of `act` while another `act` or a `withdraw` on the same signal runs. */
const SIGNAL_BUSY_FOR_ACT =
  "another action or a withdrawal on this signal is still running; wait for it to finish, then read the signal again";

/** The refusal of `withdraw` while an action on the same signal runs. */
const SIGNAL_BUSY_FOR_WITHDRAW =
  "an action on this signal is running; withdraw it once it finishes";

/** The core's Dismiss: an action that resolves the signal and runs nothing. */
const DISMISS_ACTION: BoundAction = {
  id: DISMISS_ACTION_ID,
  label: "Dismiss",
  operation: null,
};

/**
 * An action's describe line before the describer runs: the checked operation
 * the describer writes the line from, or the line itself when the action runs
 * nothing or its operation no longer passes the check.
 */
type PendingDescribeLine =
  | { readonly _tag: "checked"; readonly operation: CheckedOperation }
  | { readonly _tag: "written"; readonly describeLine: DescribeLine };

/**
 * Returns the actions the core lays out for a kind, before the Hand to an
 * agent actions: Accept and Dismiss on a proposal, Dismiss on an offer, Done
 * on an fyi, and none on an unsure, which keeps the raiser's own choices.
 */
const buildCoreActions = (input: SignalRaiseInput): ReadonlyArray<BoundAction> => {
  switch (input.kind as CoreSignalKind) {
    case "proposal":
      return [
        {
          id: ACCEPT_ACTION_ID,
          label: "Accept",
          // A proposal exists to be accepted, so Accept is the one core
          // action that is suggested.
          primary: true,
          operation: { op: "task.create", input: input.task },
        },
        DISMISS_ACTION,
      ];
    case "offer":
      return [DISMISS_ACTION];
    case "fyi":
      return [{ id: DONE_ACTION_ID, label: "Done", operation: null }];
    case "unsure":
      return [];
  }
};

/**
 * Returns one Hand to an agent action for each workflow that has a signal
 * input accepting `kind`. Each binds `run.start` with the signal's id as the
 * first such input. A proposal gets none: a workflow input cannot accept
 * `proposal`, so work always keeps its Task.
 */
const buildHandToActions = (
  signalId: string,
  kind: string,
  workflows: ReadonlyArray<{ readonly id: string; readonly definition: WorkflowDefinition }>,
): ReadonlyArray<BoundAction> =>
  workflows.flatMap(({ id, definition }) => {
    const input = (definition.inputs ?? []).find((declared) =>
      declared.signal?.kinds.includes(kind),
    );
    return input === undefined
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
 * Lists the raiser's actions that the core's own actions would make
 * ambiguous: one with the id or the label of a core action. The user picks an
 * action by its label, so two "Dismiss" buttons would be one too many.
 */
const listCollisionIssues = (
  own: ReadonlyArray<BoundAction>,
  core: ReadonlyArray<BoundAction>,
): ReadonlyArray<Issue> =>
  own.flatMap((action, index) => {
    const clash = core.find(
      (coreAction) => coreAction.id === action.id || coreAction.label === action.label,
    );
    return clash === undefined
      ? []
      : [
          {
            path: ["actions", String(index)],
            message: `The core adds its own "${clash.label}" action (id ${clash.id}) to this signal. Give your action another id and label.`,
          },
        ];
  });

/**
 * Returns the reply-filled operation of an action for `act`: the stored
 * operation with the typed text in the field the action names. Fails with
 * `Validation` when:
 *
 * - the text is missing for a typed reply, or given to an action that takes
 *   none;
 * - the filled input is larger than `MAX_BOUND_INPUT_BYTES` of JSON. The
 *   reply's own limit counts characters, and a character can take several
 *   bytes.
 */
const fillTypedReply = (
  action: BoundAction,
  text: string | undefined,
): Effect.Effect<NonNullable<BoundAction["operation"]> | null, Validation> => {
  if (action.field === undefined) {
    return text === undefined
      ? Effect.succeed(action.operation)
      : Effect.fail(
          createValidationError([
            {
              path: ["text"],
              message: `The action ${action.id} takes no typed reply. Leave out text.`,
            },
          ]),
        );
  }
  if (text === undefined || action.operation === null) {
    return Effect.fail(
      createValidationError([
        {
          path: ["text"],
          message: `The action ${action.id} sends the text you type. Give it in text.`,
        },
      ]),
    );
  }
  const input = {
    ...(action.operation.input as Readonly<Record<string, unknown>>),
    [action.field.name]: text,
  };
  if (countJsonBytes(input) > MAX_BOUND_INPUT_BYTES) {
    return Effect.fail(
      createValidationError([
        {
          path: ["text"],
          message: `With this reply, the action's input is larger than ${MAX_BOUND_INPUT_BYTES} bytes of JSON. Shorten the reply.`,
        },
      ]),
    );
  }
  return Effect.succeed({ ...action.operation, input });
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const signals = yield* signalRepository;
  const sessions = yield* sessionRepository;
  const runs = yield* runRepository;
  const workflows = yield* workflowRepository;
  const audit = yield* AuditLog;
  const operations = yield* BoundOperations;

  // The signals an action or a withdrawal is running on. A plugin action runs
  // outside any transaction, so this set is what stops a second click, or a
  // withdrawal, from acting on a signal whose first action has not resolved
  // it yet.
  const actingOn = new Set<string>();

  /**
   * Runs `effect` while it holds the claim on one signal, and gives the claim
   * up when `effect` ends, however it ends. Fails with `InvalidState`, with
   * the message `refusal`, when another caller holds the claim. Checking and
   * taking the claim is one synchronous step, so two requests that arrive
   * together cannot both take it.
   */
  const withSignalClaimed = <A, E, R>(
    signalId: string,
    refusal: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | InvalidState, R> =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (actingOn.has(signalId)) return Effect.fail(createInvalidStateError(refusal));
        actingOn.add(signalId);
        return Effect.void;
      }),
      () => effect,
      () => Effect.sync(() => actingOn.delete(signalId)),
    );

  const readOrFail = (id: string): Effect.Effect<Signal, NotFound | SqlError> =>
    Effect.flatMap(
      signals.read(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_SIGNAL)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Checks an action's operation through the port, and returns the checked
   * operation, or the `Validation` error that refused it as a failed result,
   * so a caller can collect the problems of several actions.
   */
  const checkOperation = (
    operation: NonNullable<BoundAction["operation"]>,
    field: BoundAction["field"],
    path: ReadonlyArray<string>,
  ): Effect.Effect<Result.Result<CheckedOperation, Validation>, SqlError> =>
    operations.check("signal.answer", operation, field, path).pipe(
      Effect.map((checked) => Result.succeed<CheckedOperation>(checked)),
      Effect.catchIf(
        (error) => error instanceof Validation,
        (refusal) => Effect.succeed(Result.fail(refusal)),
      ),
    );

  /**
   * Returns the `api` origin of a signal the caller raises: its stamp and,
   * for a run's session or a run's step, the run and its workflow.
   */
  const buildApiOrigin = (
    caller: Exclude<Actor, { readonly _tag: "none" }>,
    input: SignalRaiseInput,
  ): Effect.Effect<SignalOrigin, SqlError> =>
    Effect.gen(function* () {
      let runId: string | null = null;
      let workflowId: string | null = null;
      if (caller._tag === "run") {
        runId = caller.runId;
        workflowId = caller.workflowId;
      } else if (caller._tag === "session") {
        const session = yield* sessions.one(caller.sessionId);
        runId = Option.match(session, { onNone: () => null, onSome: (found) => found.runId });
        if (runId !== null) {
          const run = yield* runs.read(runId);
          workflowId = Option.match(run, {
            onNone: () => null,
            onSome: (found) => found.workflowId,
          });
        }
      }
      return {
        type: "api",
        actor: buildActorStamp(caller),
        ...(runId === null ? {} : { runId }),
        ...(workflowId === null ? {} : { workflowId }),
        eventIds: input.eventIds,
        reason: input.reason,
      };
    });

  /**
   * Checks the raiser's own actions: each one's operation through the port,
   * a typed reply only beside an operation, and no collision with a core
   * action. Fails with `Validation` listing every problem.
   */
  const checkRaisedActions = (
    own: ReadonlyArray<BoundAction>,
    core: ReadonlyArray<BoundAction>,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const issues: Array<Issue> = [...listCollisionIssues(own, core)];
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
        const checked = yield* checkOperation(action.operation, action.field, path);
        if (Result.isFailure(checked)) issues.push(...checked.failure.error.details.issues);
      }
      if (issues.length > 0) return yield* Effect.fail(createValidationError(issues));
    });

  /**
   * Checks an action's stored operation again before it is described. One
   * that no longer passes, because a plugin was disabled or a schema
   * changed, gets the line "Cannot be taken: <why>".
   */
  const checkForDescribeLine = (
    action: SignalAction,
  ): Effect.Effect<PendingDescribeLine, SqlError> => {
    if (action.operation === null) {
      return Effect.succeed({
        _tag: "written",
        describeLine:
          action.id === DONE_ACTION_ID ? DONE_DESCRIBE_LINE : NO_OPERATION_DESCRIBE_LINE,
      });
    }
    return Effect.map(
      checkOperation(action.operation, action.field, []),
      (checked): PendingDescribeLine =>
        Result.isSuccess(checked)
          ? { _tag: "checked", operation: checked.success }
          : {
              _tag: "written",
              describeLine: [
                {
                  kind: "text",
                  text: `Cannot be taken: ${checked.failure.error.details.issues[0]?.message ?? checked.failure.error.message}`,
                },
              ],
            },
    );
  };

  /**
   * Returns the signals with the describe line on each action of each open
   * signal, for the user. A resolved signal's actions can no longer be
   * taken, so it is returned as stored. The operations of every action of
   * every signal are described in one call to the describer.
   */
  const addDescribeLines = (
    list: ReadonlyArray<Signal>,
  ): Effect.Effect<ReadonlyArray<Signal>, SqlError> =>
    Effect.gen(function* () {
      const pending = yield* Effect.forEach(list, (signal) =>
        signal.status === "open"
          ? Effect.forEach(signal.actions, checkForDescribeLine)
          : Effect.succeed([]),
      );
      const lines = yield* operations.describe(
        pending.flat().flatMap((entry) => (entry._tag === "checked" ? [entry.operation] : [])),
      );
      // The describer returns the lines in the order of the operations it
      // was given, which is the order this walk visits them in.
      let nextLine = 0;
      return list.map((signal, signalIndex) => {
        if (signal.status !== "open") return signal;
        const actions = signal.actions.map((action, index): SignalAction => {
          const entry = pending[signalIndex]![index]!;
          const describeLine = entry._tag === "written" ? entry.describeLine : lines[nextLine++]!;
          return { ...action, describeLine };
        });
        return { ...signal, actions };
      });
    });

  /**
   * Returns the line the Done list shows for an action the user took:
   *
   * - Accept: "Accepted <task title>";
   * - Hand to an agent: "Handed to <workflow name>";
   * - Dismiss: "Dismissed";
   * - a plugin action: its own `outcome` line, when it writes one;
   * - anything else: the action's label.
   *
   * The action is told apart by its id. That is sound because only the core
   * uses these ids: `signal.raise` refuses a raiser's action with one.
   */
  const writeOutcome = (
    signal: Signal,
    action: BoundAction,
    pluginOutcome: string | undefined,
  ): Effect.Effect<string, SqlError> =>
    Effect.gen(function* () {
      if (pluginOutcome !== undefined) return pluginOutcome;
      if (action.id === ACCEPT_ACTION_ID && signal.task !== undefined) {
        return `Accepted ${signal.task.title}`;
      }
      if (action.id === DISMISS_ACTION_ID) return "Dismissed";
      if (action.id.startsWith(HAND_TO_ACTION_PREFIX)) {
        const workflowId = action.id.slice(HAND_TO_ACTION_PREFIX.length);
        const definition = yield* workflows.readDefinition(workflowId);
        return Option.match(definition, {
          onNone: () => action.label,
          onSome: (found) => `Handed to ${found.name}`,
        });
      }
      return action.label;
    });

  /**
   * Resolves the signal as decided with the action the user took, and
   * records it, in the caller's transaction. Fails with `InvalidState` when
   * the signal was resolved in the meantime.
   */
  const decide = (
    caller: UserActor,
    signal: Signal,
    action: BoundAction,
    checked: CheckedOperation | null,
    outcome: string,
  ): Effect.Effect<void, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const actor = buildActorStamp(caller);
      const resolution: SignalResolution = {
        kind: "decided",
        actionId: action.id,
        outcome,
        actor,
        origin: buildResolutionOrigin(caller),
        at: yield* nowIso,
      };
      // The status is checked by the write itself, so a resolution that lands
      // between the read and this write still wins.
      if (!(yield* signals.resolve(signal.id, resolution))) {
        return yield* Effect.fail(createInvalidStateError(ALREADY_RESOLVED));
      }
      yield* audit.append({
        kind: "signal.decided",
        actor,
        record: { topic: "signal", id: signal.id },
        payload: { signalId: signal.id, actionId: action.id, op: checked?.op ?? null },
        at: resolution.at,
      });
    });

  return {
    /**
     * Returns every open signal, oldest first, with the filters applied. The
     * list is not paged: every client counts the whole of To do.
     *
     * - `kind` keeps one kind.
     * - `source` keeps the kinds of one plugin, such as `github`. A core
     *   kind belongs to no plugin, so it never matches a source.
     *
     * The describe lines are added only for the user, the only caller who
     * can take an action.
     */
    query: (
      filter: SignalFilter,
    ): Effect.Effect<ReadonlyArray<Signal>, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("signal.query");
        const open = yield* signals.listOpen({
          ...(filter.kind === undefined ? {} : { kind: filter.kind }),
          ...(filter.source === undefined ? {} : { source: filter.source }),
        });
        return caller._tag === "user" ? yield* addDescribeLines(open) : open;
      }),

    /**
     * Returns one signal by id. For the user, each action of an open signal
     * carries its describe line. Fails with `NotFound` if it does not exist.
     */
    read: (id: Id): Effect.Effect<Signal, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("signal.read");
        const signal = yield* readOrFail(id);
        if (caller._tag !== "user") return signal;
        const [described] = yield* addDescribeLines([signal]);
        return described!;
      }),

    /**
     * Raises a signal of a core kind as the caller, and returns its id. The
     * core fills in the origin from the caller and lays out its own actions
     * beside the raiser's (see the module comment).
     *
     * Fails with `Validation` when one of the raiser's actions:
     *
     * - binds an operation that is not usable as a signal's answer, or whose
     *   input or Connection does not pass the check;
     * - has a typed reply that does not fit its operation;
     * - has the id or the label of an action the core adds.
     *
     * It also fails with `Validation` when the signal, with the core's
     * actions added, does not fit the `Signal` schema. The input's own
     * limits are meant to rule that out, so this check is what catches a
     * limit that drifted.
     */
    raise: (
      input: SignalRaiseInput,
    ): Effect.Effect<SignalRaiseResult, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("signal.raise");
        if (caller._tag === "none") return yield* Effect.die("signal.raise reached with no actor");
        const id = uuidToString(mintUuid());
        const own = input.actions ?? [];
        const handTo =
          input.kind === "proposal"
            ? []
            : buildHandToActions(id, input.kind, yield* workflows.listEnabledDefinitions());
        const core = [...handTo, ...buildCoreActions(input)];
        yield* checkRaisedActions(own, core);
        const origin = yield* buildApiOrigin(caller, input);
        const actor = buildActorStamp(caller);
        const createdAt = yield* nowIso;
        const signal: Signal = {
          id,
          kind: input.kind,
          origin,
          title: input.title,
          priority: input.priority ?? "normal",
          blocks: input.blocks ?? [],
          actions: [...own, ...core],
          match: {},
          ...(input.task === undefined ? {} : { task: input.task }),
          status: "open",
          createdAt,
        };
        yield* Effect.mapError(Schema.encodeEffect(Signal)(signal), (error) =>
          createValidationError(
            listSchemaIssues(error.issue),
            "the signal does not fit the Signal schema once the core adds its own actions",
          ),
        );
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* signals.insert(signal, input.eventIds);
            yield* audit.append({
              kind: "signal.raised",
              actor,
              record: { topic: "signal", id },
              payload: { signalId: id, kind: input.kind },
              at: createdAt,
            });
          }),
        );
        return { signalId: id };
      }),

    /**
     * Takes one action of an open signal: runs its operation as the user,
     * resolves the signal as decided with that action, and returns the signal
     * as it reads afterwards. An action that runs nothing only resolves the
     * signal. Done is not taken here; see `SignalActInput`.
     *
     * The rules:
     *
     * - Only the user may act; the raiser's grants are never checked, because
     *   the user's click is the authorisation.
     * - The action's operation is checked again first, with the typed reply
     *   filled in, because a plugin, a Connection or a schema may have
     *   changed since the signal was raised.
     * - A contract operation runs in the transaction that resolves the
     *   signal, so both commit or neither does.
     * - A plugin action reaches outside the controller, so it runs outside any
     *   transaction (ADR 0004), and the signal is resolved after it succeeds.
     * - Every action holds the claim on the signal while it runs, and the
     *   signal is read only once the claim is held. So a second action, or a
     *   withdrawal, is refused until the first action ends, and an action
     *   never runs on a signal that was resolved a moment before.
     *
     * Fails with:
     *
     * - `Forbidden` for any caller but the user;
     * - `NotFound` if the signal does not exist or has no such action;
     * - `InvalidState` if the signal is already resolved, or another action
     *   or a withdrawal on it is running;
     * - `Validation` if the typed reply is missing or not wanted, or the
     *   operation no longer passes the check; the signal stays open;
     * - the operation's own error when it fails; the signal stays open.
     */
    act: (input: ActInput): Effect.Effect<Signal, BoundOperationError> =>
      Effect.gen(function* () {
        const caller = yield* requireUserActor("signal.act", ONLY_THE_USER);
        return yield* withSignalClaimed(
          input.id,
          SIGNAL_BUSY_FOR_ACT,
          Effect.gen(function* () {
            const signal = yield* readOrFail(input.id);
            if (signal.status !== "open") {
              return yield* Effect.fail(createInvalidStateError(ALREADY_RESOLVED));
            }
            const action = signal.actions.find((candidate) => candidate.id === input.actionId);
            if (action === undefined) {
              const offered = signal.actions.map((offer) => offer.id).join(", ");
              return yield* Effect.fail(
                createNotFoundError(
                  `the signal has no action "${input.actionId}"; its actions are ${offered}`,
                ),
              );
            }
            const operation = yield* fillTypedReply(action, input.text);
            const checked =
              operation === null
                ? null
                : yield* operations.check("signal.answer", operation, undefined, []);
            if (checked !== null && isPluginAnswerOperation(checked)) {
              const pluginOutcome = yield* operations.runPluginAction(checked);
              const outcome = yield* writeOutcome(signal, action, pluginOutcome);
              yield* withTransaction(sql, decide(caller, signal, action, checked, outcome));
            } else {
              yield* withTransaction(
                sql,
                Effect.gen(function* () {
                  if (checked !== null) yield* operations.run(checked);
                  const outcome = yield* writeOutcome(signal, action, undefined);
                  yield* decide(caller, signal, action, checked, outcome);
                }),
              );
            }
            return yield* readOrFail(input.id);
          }),
        );
      }),

    /**
     * Withdraws an open signal because no move is asked of the user any
     * more, and returns it resolved. Only the actor that raised the signal
     * may withdraw it.
     *
     * Fails with:
     *
     * - `Forbidden` if the caller did not raise the signal, which includes
     *   every signal the core raised from an event;
     * - `NotFound` if the signal does not exist;
     * - `InvalidState` if it is already resolved, or an action on it is
     *   running. Withdrawing then could resolve the signal under an action
     *   whose effect is already on its way.
     */
    withdraw: (
      input: WithdrawInput,
    ): Effect.Effect<
      Signal,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("signal.withdraw");
        if (caller._tag === "none")
          return yield* Effect.die("signal.withdraw reached with no actor");
        const actor = buildActorStamp(caller);
        const withdrawInTransaction = withTransaction(
          sql,
          Effect.gen(function* () {
            const signal = yield* readOrFail(input.id);
            if (signal.origin.type !== "api" || signal.origin.actor !== actor) {
              return yield* Effect.fail(
                createForbiddenError(
                  "signal.write",
                  "only the actor that raised a signal may withdraw it; leave it for the user to answer, or ask its raiser to withdraw it",
                ),
              );
            }
            const resolution: SignalResolution = {
              kind: "withdrawn",
              outcome: input.reason,
              actor,
              origin: buildResolutionOrigin(caller),
              at: yield* nowIso,
            };
            if (!(yield* signals.resolve(input.id, resolution))) {
              return yield* Effect.fail(createInvalidStateError("the signal is already resolved"));
            }
            yield* audit.append({
              kind: "signal.withdrawn",
              actor,
              record: { topic: "signal", id: input.id },
              payload: { signalId: input.id, reason: input.reason },
              at: resolution.at,
            });
            return { ...signal, status: "resolved" as const, resolution };
          }),
        );
        return yield* withSignalClaimed(input.id, SIGNAL_BUSY_FOR_WITHDRAW, withdrawInTransaction);
      }),
  };
});

/** The signal service. */
export class SignalService extends Context.Service<SignalService, Effect.Success<typeof make>>()(
  "hercule/controller/signals/SignalService",
) {}

export const SignalServiceLayer: Layer.Layer<
  SignalService,
  never,
  SqlClient.SqlClient | AuditLog | BoundOperations
> = Layer.effect(SignalService)(make);
