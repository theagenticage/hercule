/**
 * The contract operations a user's answer may run, and the check that an
 * answer's operation may run where it is bound, with an input that fits.
 *
 * A producer binds an operation to a Bound Action on a decision Notification
 * or a Signal, and the operation runs as the user when the user picks it. The
 * producer's own grants are not checked, because the user's click is the
 * authorisation. So an operation opts in, row by row: its `usableIn` in the
 * operation table lists the places where it may be bound. These never belong
 * there, and `bound-operations.test.ts` fails when one is added:
 *
 * - operations of the `credential`, `secret`, `infra` and `permission`
 *   families, and those that need `connection.manage`;
 * - operations that destroy in bulk: every `*.delete` and `*.purge`.
 *
 * Each operation that lists a place has a schema of its whole input as one
 * object, ids included, because an answer has no URL path to carry an id in.
 * The core checks an answer when the Notification or the Signal is written
 * and again when the answer is taken, since `usableIn` or a schema may have
 * changed in between.
 *
 * A plugin's workflow action may be bound too, by its qualified id. This
 * module does not check one: the controller holds the action's input schema
 * and its own `usableIn`, and checks it against those.
 *
 * Spec 10 §7.4 and §9.4, and spec 11 §2 (`notification`), own the rules.
 */
import type { AnswerPlace } from "@hercule/plugin-host";
import { Effect, Schema } from "effect";
import { createValidationError, listSchemaIssues, type Validation } from "./errors";
import { RunStartCall } from "./groups/run";
import { SessionInputCall, SessionRespondToApprovalRequestCall } from "./groups/session";
import { TaskCreateInput, TaskUpdateCall } from "./groups/task";
import { ALL_OPERATIONS, OPERATIONS, type OperationId } from "./operations";

type OperationTable = typeof OPERATIONS;

/**
 * The id of an operation whose `usableIn` lists the place `Place`. With the
 * default, the id of every operation that lists any answer place.
 */
export type AnswerOperationId<Place extends AnswerPlace = AnswerPlace> = {
  readonly [Op in OperationId]: OperationTable[Op] extends {
    readonly usableIn: ReadonlyArray<infer Listed>;
  }
    ? Place extends Listed
      ? Op
      : never
    : never;
}[OperationId];

/**
 * The schema of each answer operation's whole input. Its keys are exactly the
 * operations that list an answer place, so a row that gains `usableIn`
 * without a schema here fails to compile.
 */
const ANSWER_OPERATION_INPUTS = {
  "task.create": TaskCreateInput,
  "task.update": TaskUpdateCall,
  "run.start": RunStartCall,
  "session.input": SessionInputCall,
  "session.respondToApprovalRequest": SessionRespondToApprovalRequestCall,
} as const satisfies Record<AnswerOperationId, Schema.Top>;

/** The decoded input of the operation `Op` when an answer runs it. */
export type AnswerOperationInput<Op extends AnswerOperationId> = Schema.Schema.Type<
  (typeof ANSWER_OPERATION_INPUTS)[Op]
>;

/**
 * An answer's operation after the check: an operation that may run in the
 * place `Place`, and its decoded input.
 */
export type AnswerOperation<Place extends AnswerPlace = AnswerPlace> = {
  readonly [Op in AnswerOperationId<Place>]: {
    readonly op: Op;
    readonly input: AnswerOperationInput<Op>;
  };
}[AnswerOperationId<Place>];

/**
 * A table with one function for each operation that may run in the place
 * `Place`, each taking that operation's decoded input and returning an `R`.
 * The describe line and the execution of an answer are both written as such
 * a table, so an operation that starts listing the place fails to compile
 * until every table for that place handles it.
 */
export type AnswerOperationHandlers<Place extends AnswerPlace, R> = {
  readonly [Op in AnswerOperationId<Place>]: (input: AnswerOperationInput<Op>) => R;
};

/**
 * Calls the handler for an operation's `op` with the operation's input, and
 * returns what the handler returns.
 */
export const dispatchAnswerOperation = <Place extends AnswerPlace, R>(
  handlers: AnswerOperationHandlers<Place, R>,
  operation: AnswerOperation<Place>,
): R => {
  // TypeScript cannot tell that `operation.op` and `operation.input` belong
  // to the same member of the union, so it rejects the call. The handler is
  // widened to take any answer operation's input; `AnswerOperationHandlers`
  // is what ties each operation to a handler for its own input.
  const handler = (handlers as Record<string, (input: unknown) => R>)[operation.op]!;
  return handler(operation.input);
};

/**
 * The session id a session writes in an answer's input to name itself. An
 * agent binds `session.input` to itself this way to get the user's answer
 * back as its next input, without having to know its own id. The core
 * replaces it with the session's id before it checks and stores the answer.
 */
export const OWN_SESSION_ALIAS = "me";

/** Returns the ids of the operations that list `place` in `usableIn`, in table order. */
export const listAnswerOperations = <Place extends AnswerPlace>(
  place: Place,
): ReadonlyArray<AnswerOperationId<Place>> =>
  ALL_OPERATIONS.filter((operation) => operation.usableIn?.includes(place) === true).map(
    (operation) => operation.id as AnswerOperationId<Place>,
  );

/**
 * Returns the record an answer in `place` sits on, as the word a message
 * uses: "signal" or "notification".
 */
export const nameAnswerRecord = (place: AnswerPlace): string =>
  place === "signal.answer" ? "signal" : "notification";

/** Checks whether an operation id lists `place` in its `usableIn`. */
const isUsableIn = <Place extends AnswerPlace>(
  place: Place,
  op: string,
): op is AnswerOperationId<Place> =>
  Object.hasOwn(ANSWER_OPERATION_INPUTS, op) &&
  (OPERATIONS[op as AnswerOperationId].usableIn as ReadonlyArray<AnswerPlace>).includes(place);

/**
 * Checks that an answer's contract operation lists `place` in its
 * `usableIn`, and decodes its input with that operation's schema. Returns the
 * decoded operation. Fails with `Validation` when the operation may not run
 * there or the input does not fit, with each issue's path starting at
 * `path`, such as `["actions", "0", "operation"]`.
 *
 * It checks contract operations only. A caller that accepts plugin actions
 * checks `isQualifiedId(op)` first and decodes such an operation against the
 * plugin action's own input schema and `usableIn`.
 */
export const decodeAnswerOperation = <Place extends AnswerPlace>(
  place: Place,
  operation: { readonly op: string; readonly input: unknown },
  path: ReadonlyArray<string>,
): Effect.Effect<AnswerOperation<Place>, Validation> => {
  const { op, input } = operation;
  if (!isUsableIn(place, op)) {
    const record = nameAnswerRecord(place);
    return Effect.fail(
      createValidationError([
        {
          path: [...path, "op"],
          message: `An answer on a ${record} cannot run ${op}. An answer on a ${record} can run one of: ${listAnswerOperations(place).join(", ")}, or a plugin action that lists ${place} in its usableIn.`,
        },
      ]),
    );
  }
  return Schema.decodeUnknownEffect(ANSWER_OPERATION_INPUTS[op as AnswerOperationId])(input).pipe(
    Effect.map((decoded) => ({ op, input: decoded }) as AnswerOperation<Place>),
    Effect.mapError((error) =>
      createValidationError(listSchemaIssues(error.issue, { path: [...path, "input"] })),
    ),
  );
};
