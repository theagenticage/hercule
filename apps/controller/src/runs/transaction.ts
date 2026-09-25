/** The one way the run engine commits a write set. */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { withTransaction } from "../db";

/**
 * Runs one of a run's write sets in a transaction that cannot be interrupted,
 * and returns what the write set returns. Fails with what the write set
 * fails with, or with a database error.
 *
 * Cancelling a run interrupts its execution, and an interrupt that landed
 * after the commit and before the transaction's after-commit work would lose
 * that work: the live announcements, and handing a child run that a
 * `run.start` step committed to the Run Executor. The write set only touches
 * the local database, so the interrupt waits a moment at most.
 */
export const commitUninterruptibly = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> => Effect.uninterruptible(withTransaction(sql, effect));
