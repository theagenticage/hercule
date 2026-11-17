/**
 * Stores and reads the taint flag of a session: whether it has read
 * third-party messages (spec 13 section 10). The flag lives in
 * `sessions.tainted`, stays inside this module, and is never part of the
 * session record the API returns.
 *
 * Nothing clears the flag. Every function runs on the ambient `SqlClient`, so
 * a caller can run it inside its own `withTransaction`; the writes here do not
 * open one.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor } from "../actor";
import { uuidFromString } from "../db";

/**
 * The taint service: reads and writes the taint flag of sessions. Building it
 * needs the ambient `SqlClient`, and every function it holds runs on that
 * client, so inside the caller's transaction when there is one.
 */
export const sessionTaint = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Reads the flag of a session row. Returns false when the row does not exist. */
  const readFlag = (sessionId: string) =>
    sql<{ readonly tainted: number }>`
      SELECT tainted FROM sessions WHERE id = ${uuidFromString(sessionId)}
    `.pipe(Effect.map((rows) => rows[0]?.tainted === 1));

  /**
   * Marks a session as tainted. Does nothing when it already is, or when the
   * session does not exist. Fails with an `SqlError`.
   *
   * This is the one controller function that taints a session from nothing.
   * The core calls it when it delivers a session a third-party line wrapped
   * as data. No channel does that yet, so only tests call it today.
   */
  const markTainted = (sessionId: string) =>
    sql`UPDATE sessions SET tainted = 1 WHERE id = ${uuidFromString(sessionId)}`.pipe(
      Effect.asVoid,
    );

  /**
   * Checks whether the current caller is a tainted session. Returns false for
   * the user, a run, no actor, and a session whose row does not exist. Fails
   * with an `SqlError`.
   *
   * It reads the row each time, so a caller sees a taint set after its token
   * was resolved.
   */
  const isCallerTainted = Effect.flatMap(CurrentActor, (actor) =>
    actor._tag === "session" ? readFlag(actor.sessionId) : Effect.succeed(false),
  );

  /**
   * Taints a session that a tainted caller has put text into, or that carries
   * a tainted session's transcript. Does nothing unless the current caller is
   * a tainted session, or `parentSessionId` names a tainted session (a fork
   * of it). It never clears a flag. Fails with an `SqlError`.
   *
   * Taint has to pass on, or a tainted session could hand its work to a clean
   * one and act through it. One statement decides and writes, so the check
   * and the write cannot see different rows.
   */
  const passOn = (sessionId: string, parentSessionId?: string) =>
    Effect.gen(function* () {
      const actor = yield* CurrentActor;
      const sourceIds = [
        ...(actor._tag === "session" ? [actor.sessionId] : []),
        ...(parentSessionId === undefined ? [] : [parentSessionId]),
      ].map(uuidFromString);
      if (sourceIds.length === 0) return;
      yield* sql`
        UPDATE sessions SET tainted = 1
        WHERE id = ${uuidFromString(sessionId)} AND tainted = 0
          AND EXISTS (SELECT 1 FROM sessions WHERE tainted = 1 AND ${sql.in("id", sourceIds)})
      `;
    });

  return { markTainted, isCallerTainted, passOn };
});
