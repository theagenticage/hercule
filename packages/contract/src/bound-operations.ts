/**
 * The operations an answer to a decision may run, and the check that an
 * answer's operation is one of them with an input that fits.
 *
 * A producer binds an operation to an answer, and the operation runs as the
 * user when the user takes that answer. The producer's own grants are not
 * checked, because the user's click is the authorisation. So the list below
 * is a guardrail. It is short on purpose, and an operation is added only when
 * a user would sensibly run it from one click. These never belong on it, and
 * `bound-operations.test.ts` fails when one is added:
 *
 * - operations of the `credential`, `secret`, `infra` and `permission`
 *   families, and those that need `connection.manage`;
 * - operations that destroy in bulk: every `*.delete` and `*.purge`.
 *
 * Each entry's schema covers the operation's whole input as one object, ids
 * included, because an answer has no URL path to carry an id in. The core
 * checks an answer against this list when the notification is created and
 * again when the answer is taken, since the list or a schema may have changed
 * in between.
 *
 * Spec 10 §7.4 and spec 11 §3.2 own the rules.
 */
import { Effect, Schema } from "effect";
import { createValidationError, listSchemaIssues, type Validation } from "./errors";
import { RunStartCall } from "./groups/run";
import { SessionInputCall, SessionRespondToApprovalRequestCall } from "./groups/session";
import { TaskUpdateCall } from "./groups/task";
import type { OperationId } from "./operations";

/** The operations an answer may run, each with the schema of its whole input. */
export const BINDABLE_OPERATIONS = {
  "task.update": TaskUpdateCall,
  "run.start": RunStartCall,
  "session.input": SessionInputCall,
  "session.respondToApprovalRequest": SessionRespondToApprovalRequestCall,
} as const satisfies Partial<Record<OperationId, Schema.Top>>;

/** The id of an operation an answer may run. */
export type BindableOperationId = keyof typeof BINDABLE_OPERATIONS;

/** The ids of the operations an answer may run, in the order of the list. */
export const BINDABLE_OPERATION_IDS = Object.keys(
  BINDABLE_OPERATIONS,
) as ReadonlyArray<BindableOperationId>;

/** The decoded input of the operation `Op` when an answer runs it. */
export type BindableOperationInput<Op extends BindableOperationId> = Schema.Schema.Type<
  (typeof BINDABLE_OPERATIONS)[Op]
>;

/** An answer's operation after the check: an operation an answer may run, and its decoded input. */
export type BindableOperation = {
  readonly [Op in BindableOperationId]: {
    readonly op: Op;
    readonly input: BindableOperationInput<Op>;
  };
}[BindableOperationId];

/**
 * A table with one function for each operation an answer may run, each taking
 * that operation's decoded input and returning an `R`. The describe line and
 * the execution of an answer are both written as such a table, so a new
 * operation on the list fails to compile until every table handles it.
 */
export type BindableOperationHandlers<R> = {
  readonly [Op in BindableOperationId]: (input: BindableOperationInput<Op>) => R;
};

/**
 * Calls the handler for an operation's `op` with the operation's input, and
 * returns what the handler returns.
 */
export const dispatchBindableOperation = <R>(
  handlers: BindableOperationHandlers<R>,
  operation: BindableOperation,
): R => {
  // TypeScript cannot tell that `operation.op` and `operation.input` belong
  // to the same member of the union, so it rejects the call. The handler is
  // widened to take any bindable input; `BindableOperationHandlers` is what
  // ties each operation to a handler for its own input.
  const handler = handlers[operation.op] as (
    input: BindableOperationInput<BindableOperationId>,
  ) => R;
  return handler(operation.input);
};

/**
 * The session id a session writes in an answer's input to name itself. An
 * agent binds `session.input` to itself this way to get the user's answer
 * back as its next input, without having to know its own id. The core
 * replaces it with the session's id before it checks and stores the answer.
 */
export const OWN_SESSION_ALIAS = "me";

/** Checks whether an operation id is one an answer may run. */
const isBindableOperationId = (op: string): op is BindableOperationId =>
  Object.hasOwn(BINDABLE_OPERATIONS, op);

/**
 * Checks that an answer's operation is one an answer may run, and decodes its
 * input with that operation's schema. Returns the decoded operation. Fails
 * with `Validation` when the operation is not on the list or the input does
 * not fit, with each issue's path starting at `path`, such as
 * `["actions", "0", "operation"]`.
 */
export const decodeBindableOperation = (
  operation: { readonly op: string; readonly input: unknown },
  path: ReadonlyArray<string>,
): Effect.Effect<BindableOperation, Validation> => {
  const { op, input } = operation;
  if (!isBindableOperationId(op)) {
    return Effect.fail(
      createValidationError([
        {
          path: [...path, "op"],
          message: `An answer cannot run ${op}. An answer can run one of: ${BINDABLE_OPERATION_IDS.join(", ")}.`,
        },
      ]),
    );
  }
  return Schema.decodeUnknownEffect(BINDABLE_OPERATIONS[op])(input).pipe(
    Effect.map((decoded) => ({ op, input: decoded }) as BindableOperation),
    Effect.mapError((error) =>
      createValidationError(listSchemaIssues(error.issue, { path: [...path, "input"] })),
    ),
  );
};
