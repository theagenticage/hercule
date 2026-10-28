/**
 * The signal operations: `signal.query`, `read`, `raise`, `act`, `handOff`
 * and `withdraw`, and the four moves that send nothing to the source:
 * `markDone`, `snooze`, `unsnooze` and `lowerPriority`.
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
 *   enabled, valid workflow with a signal input that accepts the kind.
 *
 * The core also raises one offer of its own: when the user marks the last
 * five signals of one group done without answering them, `markDone` offers
 * an Ignore Rule for that group, with Ignore and Dismiss.
 *
 * Only the user takes an action, through `act`, or hands a signal to a
 * workflow, through `handOff`, which takes that workflow's Hand to an agent
 * action. Each action's operation is
 * checked, run and described through the `BoundOperations` port, which the
 * controller daemon implements.
 *
 * The four moves each take a list of ids, because one user action, such as a
 * bulk snooze, is one call. Each call:
 *
 * - fails as a whole with `NotFound` when an id names no signal;
 * - treats an id given twice as given once;
 * - skips a signal that resolved before the call, and returns it in
 *   `skipped`;
 * - writes one audit entry naming the signals it changed, and none when it
 *   changed nothing.
 *
 * Spec 10 §9 owns the rules.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  ACCEPT_ACTION_ID,
  countJsonBytes,
  createForbiddenError,
  DEFAULT_PAGE_LIMIT,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  DISMISS_ACTION_ID,
  DONE_ACTION_ID,
  HAND_TO_ACTION_PREFIX,
  IGNORE_ACTION_ID,
  MAX_BOUND_INPUT_BYTES,
  type Signal,
  Validation,
  hasSameValues,
  type AnswerOperation,
  type BoundAction,
  type CoreSignalKind,
  type DescribeLine,
  NO_OPERATION_DESCRIBE_LINE,
  type Forbidden,
  type Id,
  type InvalidState,
  type Issue,
  type NotFound,
  type RunStarted,
  type SignalAction,
  type SignalActInput,
  type SignalHandOffInput,
  type SignalFilter,
  type SignalIdsInput,
  type SignalLowerPriorityResult,
  type SignalMarkDoneResult,
  type SignalOrigin,
  type SignalPage,
  type SignalSnoozeInput,
  type SignalSnoozeResult,
  type SignalUnsnoozeResult,
  type SkippedSignal,
  type SignalRaiseInput,
  type SignalRaiseResult,
  type SignalResolution,
  type SignalWithdrawInput,
  type Unauthenticated,
} from "@hercule/contract";
import {
  buildActorStamp,
  buildResolutionOrigin,
  requireActor,
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
import { mintUuid, nowIso, refuseCursor, uuidToString, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import { runRepository } from "../runs";
import { sessionRepository } from "../sessions";
import { workflowRepository } from "../workflows";
import {
  buildHandToActions,
  checkSignalFits,
  DISMISS_ACTION,
  listOwnActionIssues,
} from "./actions";
import { SignalClaims } from "./claims";
import { ignoreRuleOffers } from "./ignore-rule-offers";
import { ignoreRuleRepository } from "./ignore-rule-repository";
import { buildIgnoredOutcome } from "./outcome";
import { ALREADY_RESOLVED, checkOffersHandoff, ONLY_THE_USER_HANDS_OFF } from "./handoffs";
import { signalRepository } from "./repository";

/** The input of `signal.act`: the signal's id, the action to take and its typed reply. */
export interface ActInput extends SignalActInput {
  readonly id: Id;
}

/** The input of `signal.handOff`: the signal's id and the workflow to hand it to. */
export interface HandOffInput extends SignalHandOffInput {
  readonly id: Id;
}

/** The input of `signal.withdraw`: the signal's id and the reason. */
export interface WithdrawInput extends SignalWithdrawInput {
  readonly id: Id;
}

const NO_SUCH_SIGNAL = "no such signal";

/**
 * The describe line of the core's Done on a core kind. A plugin's kind adds
 * which source is not told; a core kind has no source to tell.
 */
const DONE_DESCRIBE_LINE: DescribeLine = [{ kind: "text", text: "Takes it off your list" }];

/**
 * Returns the describe line of the core's Done on a plugin's signal. Done
 * resolves the signal in the controller only, so the line says that the
 * source, such as a pull request's review request, stays as it is.
 */
const buildPluginDoneDescribeLine = (pluginDisplayName: string): DescribeLine => [
  { kind: "text", text: `Takes it off your list. ${pluginDisplayName} is not told` },
];

/**
 * The refusal for a caller who is not the user taking an action. A session
 * may hold `signal.write`, the grant this operation checks, so the message
 * says why the grant does not help.
 */
const ONLY_THE_USER =
  "only the user may take a signal's action: it runs its operation as the user, so a session or a workflow step may not take one; ask the user instead";

/** The refusal of `markDone` for a caller who is not the user. */
const ONLY_THE_USER_MARKS_DONE =
  "only the user may mark a signal done: Done is the user's answer, so a session or a workflow step may not give it; ask the user instead";

/**
 * The refusal of `lowerPriority` for a caller who is not the user. An agent
 * must not quietly lower what the user was told is urgent.
 */
const ONLY_THE_USER_LOWERS_PRIORITY =
  "only the user may move a signal out of Now: the user was told it is urgent, so a session or a workflow step may not lower it; ask the user instead";

/** The resolution outcome of Done, which sends nothing to the source. */
const DONE_OUTCOME = "Done, nothing sent";

/** The refusal of `act` while another `act` or a `withdraw` on the same signal runs. */
const SIGNAL_BUSY_FOR_ACT =
  "another action or a withdrawal on this signal is still running; wait for it to finish, then read the signal again";

/** The refusal of `withdraw` while an action on the same signal runs. */
const SIGNAL_BUSY_FOR_WITHDRAW =
  "an action on this signal is running; withdraw it once it finishes";

/** The refusal of `markDone` while an action or a withdrawal on one of its signals runs. */
const SIGNALS_BUSY_FOR_MARK_DONE =
  "an action or a withdrawal on one of these signals is still running; wait for it to finish, then read the signals again";

/**
 * Returns the ids in the order given, each once. A list operation treats an
 * id given twice as given once.
 */
const removeDuplicateIds = (ids: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(ids)];

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
 * Checks whether a checked operation is `signal.handOff`. A plugin action's
 * id is qualified, so it never equals this id.
 */
const isHandOffOperation = (
  operation: CheckedOperation,
): operation is Extract<AnswerOperation, { readonly op: "signal.handOff" }> =>
  operation.op === "signal.handOff";

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
  const rules = yield* ignoreRuleRepository;
  const audit = yield* AuditLog;
  const operations = yield* BoundOperations;
  const host = yield* PluginHost;
  const claims = yield* SignalClaims;
  const offers = yield* ignoreRuleOffers;

  const readOrFail = (id: string): Effect.Effect<Signal, NotFound | SqlError> =>
    Effect.flatMap(
      signals.read(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_SIGNAL)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Returns the signals with these ids, in the order of the ids, which must
   * hold no duplicates. Fails with `NotFound` naming every id that has no
   * signal, so a list operation changes nothing when one id is wrong.
   */
  const readManyOrFail = (
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<Signal>, NotFound | SqlError> =>
    Effect.gen(function* () {
      const byId = new Map((yield* signals.readMany(ids)).map((signal) => [signal.id, signal]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        return yield* Effect.fail(
          createNotFoundError(
            `no signal has the id ${missing.join(", ")}; nothing was changed. Check the ids, then try again`,
          ),
        );
      }
      return ids.map((id) => byId.get(id)!);
    });

  /**
   * Splits signals into the open ones, which a list operation changes, and
   * the resolved ones, which it returns in `skipped`.
   */
  const splitResolved = (
    list: ReadonlyArray<Signal>,
  ): { readonly open: ReadonlyArray<Signal>; readonly skipped: ReadonlyArray<SkippedSignal> } => ({
    open: list.filter((signal) => signal.status === "open"),
    skipped: list
      .filter((signal) => signal.status !== "open")
      .map((signal) => ({ signalId: signal.id, reason: "resolved" as const })),
  });

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
   * Returns the `api` origin of a signal the caller raises: its stamp; for a
   * run's session or a run's step, the run and its workflow; and for a
   * session of an assistant's conversation, the assistant.
   */
  const buildApiOrigin = (
    caller: Exclude<Actor, { readonly _tag: "none" }>,
    input: SignalRaiseInput,
  ): Effect.Effect<SignalOrigin, SqlError> =>
    Effect.gen(function* () {
      let runId: string | null = null;
      let workflowId: string | null = null;
      let assistantId: string | null = null;
      if (caller._tag === "run") {
        runId = caller.runId;
        workflowId = caller.workflowId;
      } else if (caller._tag === "session") {
        assistantId = caller.assistantId;
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
        ...(assistantId === null ? {} : { assistantId }),
        eventIds: input.eventIds,
        reason: input.reason,
      };
    });

  /**
   * Checks the raiser's own actions with `listOwnActionIssues`. Fails with
   * `Validation` listing every problem.
   */
  const checkRaisedActions = (
    own: ReadonlyArray<BoundAction>,
    core: ReadonlyArray<BoundAction>,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const issues = yield* Effect.provideService(
        listOwnActionIssues(own, core),
        BoundOperations,
        operations,
      );
      if (issues.length > 0) return yield* Effect.fail(createValidationError(issues));
    });

  /**
   * Checks an action's stored operation again before it is described. One
   * that no longer passes, because a plugin was disabled or a schema
   * changed, gets the line "Cannot be taken: <why>".
   */
  const checkForDescribeLine = (
    action: SignalAction,
    kind: string,
  ): Effect.Effect<PendingDescribeLine, SqlError> => {
    if (action.operation === null) {
      if (action.id !== DONE_ACTION_ID) {
        return Effect.succeed({ _tag: "written", describeLine: NO_OPERATION_DESCRIBE_LINE });
      }
      return Effect.map(host.findSignalKind(kind), (registered): PendingDescribeLine => ({
        _tag: "written",
        describeLine: Option.match(registered, {
          onNone: () => DONE_DESCRIBE_LINE,
          onSome: (pluginKind) => buildPluginDoneDescribeLine(pluginKind.pluginDisplayName),
        }),
      }));
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
          ? Effect.forEach(signal.actions, (action) => checkForDescribeLine(action, signal.kind))
          : Effect.succeed([]),
      );
      const lines = yield* operations.describe(
        pending.flat().flatMap((entry) => (entry._tag === "checked" ? [entry.operation] : [])),
        list,
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
   * - Ignore, on the core's Ignore Rule offer: "Ignored · rule <text>",
   *   with the text of the rule it just created;
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
      if (action.id === IGNORE_ACTION_ID && signal.ignoreRule !== undefined) {
        const offered = signal.ignoreRule;
        const created = (yield* rules.list(offered.kind)).find((rule) =>
          hasSameValues(rule.match, offered.match),
        );
        return created === undefined ? action.label : buildIgnoredOutcome(created.text);
      }
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
   * records it, in the caller's transaction. `startedRun` is the run the
   * action's operation started, if it started one, and is kept as
   * `resolution.runId`. Fails with `InvalidState` when the signal was
   * resolved in the meantime.
   */
  const decide = (
    caller: UserActor,
    signal: Signal,
    action: BoundAction,
    checked: CheckedOperation | null,
    outcome: string,
    startedRun: RunStarted | undefined,
  ): Effect.Effect<void, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const actor = buildActorStamp(caller);
      const resolution: SignalResolution = {
        kind: "decided",
        actionId: action.id,
        outcome,
        ...(startedRun === undefined ? {} : { runId: startedRun.runId }),
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
   *   signal, so both commit or neither does. When the operation starts a
   *   run, the signal's resolution records it as `runId`.
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
   *   operation no longer passes the check, or the action hands off a signal
   *   other than this one; the signal stays open;
   * - the operation's own error when it fails; the signal stays open.
   */
  const act = (input: ActInput): Effect.Effect<Signal, BoundOperationError> =>
    Effect.gen(function* () {
      const caller = yield* requireUserActor("signal.act", ONLY_THE_USER);
      return yield* claims.withSignalsClaimed(
        [input.id],
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
          if (
            checked !== null &&
            isHandOffOperation(checked) &&
            checked.input.signalId !== signal.id
          ) {
            return yield* Effect.fail(
              createValidationError([
                {
                  path: ["actionId"],
                  message: `The action ${action.id} hands off another signal, ${checked.input.signalId}, not this one. A Hand to an agent action hands off the signal it sits on. Take another action.`,
                },
              ]),
            );
          }
          if (checked !== null && isPluginAnswerOperation(checked)) {
            const pluginOutcome = yield* operations.runPluginAction(checked);
            const outcome = yield* writeOutcome(signal, action, pluginOutcome);
            yield* withTransaction(
              sql,
              decide(caller, signal, action, checked, outcome, undefined),
            );
          } else {
            yield* withTransaction(
              sql,
              Effect.gen(function* () {
                const startedRun = checked === null ? undefined : yield* operations.run(checked);
                const outcome = yield* writeOutcome(signal, action, undefined);
                yield* decide(caller, signal, action, checked, outcome, startedRun);
              }),
            );
          }
          return yield* readOrFail(input.id);
        }),
      );
    });

  /**
   * Hands an open signal to a workflow as the user, and returns the signal as
   * it reads afterwards. It takes the signal's Hand to an agent action for
   * that workflow, with `act`, so it holds the same claim, runs the action's
   * `signal.handOff` operation and resolves the signal in one transaction.
   *
   * A signal raised before `signal.handOff` existed offers a `run.start` Hand
   * to an agent action, and this takes that one: it starts an untracked run
   * (ADR 0046).
   *
   * Fails with:
   *
   * - `Forbidden` for any caller but the user;
   * - `NotFound` if the signal does not exist, or does not offer a Hand to an
   *   agent action for the workflow; the message lists the workflows it
   *   offers;
   * - `InvalidState` if the signal is already resolved, or another action or
   *   a withdrawal on it is running;
   * - the operation's own error when it fails, such as `Validation` for a
   *   workflow that cannot start now; the signal stays open and no Task is
   *   written.
   */
  const handOff = (input: HandOffInput): Effect.Effect<Signal, BoundOperationError> =>
    Effect.gen(function* () {
      yield* requireUserActor("signal.handOff", ONLY_THE_USER_HANDS_OFF);
      const signal = yield* readOrFail(input.id);
      yield* checkOffersHandoff(signal, input.workflowId);
      const actionId = `${HAND_TO_ACTION_PREFIX}${input.workflowId}`;
      return yield* act({ id: input.id, actionId });
    });

  return {
    act,

    handOff,

    /**
     * Returns one view of the signals, with the filters applied:
     *
     * - `to-do`, the default: the open signals that are not snoozed, or
     *   whose snooze ran out by now. The signals back from a snooze come
     *   first, then the rest oldest first. The view is not paged: every
     *   client counts the whole of To do.
     * - `later`: the signals snoozed until a future time, soonest first,
     *   one page at a time.
     * - `done`: the resolved signals, newest resolution first, one page at a
     *   time.
     *
     * `kind` keeps one kind, and `source` the kinds of one plugin, such as
     * `github`. A core kind belongs to no plugin, so it never matches a
     * source. The describe lines are added only for the user, the only
     * caller who can take an action.
     *
     * Fails with `Validation` when the cursor belongs to another view or
     * another operation.
     */
    query: (
      filter: SignalFilter,
    ): Effect.Effect<SignalPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("signal.query");
        const listFilter = {
          ...(filter.kind === undefined ? {} : { kind: filter.kind }),
          ...(filter.source === undefined ? {} : { source: filter.source }),
        };
        const request = { limit: filter.limit ?? DEFAULT_PAGE_LIMIT, cursor: filter.cursor };
        const now = yield* nowIso;
        const listing = yield* refuseCursor(
          filter.view === "later"
            ? signals.listLater(listFilter, request, now)
            : filter.view === "done"
              ? signals.listDone(listFilter, request)
              : Effect.map(signals.listToDo(listFilter, now), (items) => ({
                  items,
                  nextCursor: undefined,
                })),
        );
        return {
          items: caller._tag === "user" ? yield* addDescribeLines(listing.items) : listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
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
        const caller = yield* requireActor("signal.raise");
        const id = uuidToString(mintUuid());
        const own = input.actions ?? [];
        const handTo =
          input.kind === "proposal"
            ? []
            : buildHandToActions(id, input.kind, yield* workflows.listRunnableDefinitions());
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
        // The raise input was checked against the same limits, but Accept
        // copies the task and Hand to adds one action per workflow, so the
        // signal as written can still be larger.
        yield* Effect.mapError(checkSignalFits(signal), (refusal) =>
          createValidationError(
            refusal.error.details.issues,
            "the signal does not fit the contract once the core adds its own actions",
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
        const caller = yield* requireActor("signal.withdraw");
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
            // Read again rather than patched: resolving also deleted the
            // signal's snooze.
            return yield* readOrFail(input.id);
          }),
        );
        return yield* claims.withSignalsClaimed(
          [input.id],
          SIGNAL_BUSY_FOR_WITHDRAW,
          withdrawInTransaction,
        );
      }),

    /**
     * Marks open signals done as the user: resolves each one as `decided`
     * with the core's Done action, which sends nothing to the source, and
     * returns the ids it resolved and the ones it skipped because they had
     * already resolved.
     *
     * In the same transaction, the core offers an Ignore Rule for each group
     * of a plugin kind whose last five signals the user has now marked done
     * without answering (spec 10 §9.9, "The core suggests rules").
     *
     * Fails with:
     *
     * - `Forbidden` for any caller but the user;
     * - `NotFound` when an id names no signal;
     * - `Validation`, naming the ids, when a signal's kind has no Done
     *   action. That is checked before a signal is skipped as resolved, so a
     *   client that offers Done where there is none hears of it;
     * - `InvalidState` when an action or a withdrawal on one of the signals
     *   is running. The whole call is refused rather than that signal
     *   skipped, because the running action may still fail and leave the
     *   signal open, so it is not resolved yet.
     *
     * Nothing is changed when the call fails.
     */
    markDone: (
      input: SignalIdsInput,
    ): Effect.Effect<
      SignalMarkDoneResult,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        const caller = yield* requireUserActor("signal.markDone", ONLY_THE_USER_MARKS_DONE);
        const ids = removeDuplicateIds(input.signalIds);
        // The claims are taken before the signals are read, as in `act`, so
        // Done never resolves a signal whose action is still on its way.
        return yield* claims.withSignalsClaimed(
          ids,
          SIGNALS_BUSY_FOR_MARK_DONE,
          withTransaction(
            sql,
            Effect.gen(function* () {
              const list = yield* readManyOrFail(ids);
              const issues = list.flatMap((signal, index): ReadonlyArray<Issue> =>
                signal.actions.some((action) => action.id === DONE_ACTION_ID)
                  ? []
                  : [
                      {
                        path: ["signalIds", String(input.signalIds.indexOf(ids[index]!))],
                        message: `The signal ${signal.id} is of kind ${signal.kind}, which has no Done action. Answer it with one of its own actions instead.`,
                      },
                    ],
              );
              if (issues.length > 0) return yield* Effect.fail(createValidationError(issues));
              const { open, skipped } = splitResolved(list);
              const actor = buildActorStamp(caller);
              const at = yield* nowIso;
              const resolution: SignalResolution = {
                kind: "decided",
                actionId: DONE_ACTION_ID,
                outcome: DONE_OUTCOME,
                actor,
                origin: buildResolutionOrigin(caller),
                at,
              };
              const resolved = yield* signals.resolveMany(
                open.map((signal) => signal.id),
                resolution,
              );
              const done = ids.filter((id) => resolved.has(id));
              if (done.length > 0) {
                yield* audit.append({
                  kind: "signal.markedDone",
                  actor,
                  record: { topic: "signal", ids: done },
                  payload: { signalIds: done },
                  at,
                });
              }
              yield* offers.offerIgnoreRules(
                open.filter((signal) => resolved.has(signal.id)),
                at,
              );
              return { done, skipped };
            }),
          ),
        );
      }),

    /**
     * Snoozes open signals until `until`, and returns the ids it snoozed and
     * the ones it skipped because they had already resolved. A signal that
     * is already snoozed gets the new time. Any holder of `signal.write` may
     * snooze, because a snooze is not an answer.
     *
     * Fails with `Validation` when `until` is not after now, and with
     * `NotFound` when an id names no signal. Nothing is changed when the
     * call fails.
     */
    snooze: (
      input: SignalSnoozeInput,
    ): Effect.Effect<
      SignalSnoozeResult,
      Unauthenticated | Forbidden | Validation | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        const caller = yield* requireActor("signal.snooze");
        const ids = removeDuplicateIds(input.signalIds);
        const now = yield* nowIso;
        // The contract decodes `until` to a canonical UTC timestamp, so two
        // times compare as text.
        if (input.until <= now) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["until"],
                message: `The time ${input.until} is not in the future. Pick a time after ${now}.`,
              },
            ]),
          );
        }
        const actor = buildActorStamp(caller);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const { open, skipped } = splitResolved(yield* readManyOrFail(ids));
            const snoozed = open.map((signal) => signal.id);
            if (snoozed.length > 0) {
              yield* signals.snooze(snoozed, { until: input.until, snoozedAt: now, actor });
              yield* audit.append({
                kind: "signal.snoozed",
                actor,
                record: { topic: "signal", ids: snoozed },
                payload: { signalIds: snoozed, until: input.until },
                at: now,
              });
            }
            return { snoozed, skipped };
          }),
        );
      }),

    /**
     * Puts snoozed signals back on To do, and returns the ids it unsnoozed
     * and the ones it skipped because they had already resolved. An open
     * signal that is not snoozed is in neither list, and nothing is written
     * for it. Any holder of `signal.write` may unsnooze.
     *
     * Fails with `NotFound` when an id names no signal, and then changes
     * nothing.
     */
    unsnooze: (
      input: SignalIdsInput,
    ): Effect.Effect<SignalUnsnoozeResult, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireActor("signal.unsnooze");
        const ids = removeDuplicateIds(input.signalIds);
        const actor = buildActorStamp(caller);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const { open, skipped } = splitResolved(yield* readManyOrFail(ids));
            const deleted = yield* signals.unsnooze(open.map((signal) => signal.id));
            const unsnoozed = ids.filter((id) => deleted.has(id));
            if (unsnoozed.length > 0) {
              yield* audit.append({
                kind: "signal.unsnoozed",
                actor,
                record: { topic: "signal", ids: unsnoozed },
                payload: { signalIds: unsnoozed },
              });
            }
            return { unsnoozed, skipped };
          }),
        );
      }),

    /**
     * Moves open `urgent` signals to `high` as the user, which takes them out
     * of Now, and returns the ids it lowered and the ones it skipped because
     * they had already resolved. An open signal of any other priority is in
     * neither list. Each lowered signal is marked lowered, so the code that
     * raises a replacement can read that mark through
     * `isPriorityLowered` and keep the lower priority (issue #526).
     *
     * Fails with `Forbidden` for any caller but the user, and with
     * `NotFound` when an id names no signal. Nothing is changed when the call
     * fails.
     */
    lowerPriority: (
      input: SignalIdsInput,
    ): Effect.Effect<
      SignalLowerPriorityResult,
      Unauthenticated | Forbidden | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        const caller = yield* requireUserActor(
          "signal.lowerPriority",
          ONLY_THE_USER_LOWERS_PRIORITY,
        );
        const ids = removeDuplicateIds(input.signalIds);
        const actor = buildActorStamp(caller);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const { open, skipped } = splitResolved(yield* readManyOrFail(ids));
            const changed = yield* signals.lowerPriority(open.map((signal) => signal.id));
            const lowered = ids.filter((id) => changed.has(id));
            if (lowered.length > 0) {
              yield* audit.append({
                kind: "signal.priorityLowered",
                actor,
                record: { topic: "signal", ids: lowered },
                payload: { signalIds: lowered },
              });
            }
            return { lowered, skipped };
          }),
        );
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
  SqlClient.SqlClient | AuditLog | BoundOperations | PluginHost | SignalClaims
> = Layer.effect(SignalService)(make);
