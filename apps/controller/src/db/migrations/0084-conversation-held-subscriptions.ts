/**
 * Makes the conversation the holder of every live Subscription that a session
 * of an assistant's conversation held (spec 12 section 8.1). A conversation
 * outlives each of its sessions, so what an assistant waits for must not end
 * or move with a session.
 *
 * Only live rows change, and only when the holder session answers a
 * conversation that still exists. Three kinds of row stay as they are:
 *
 * - an ended Subscription, which is a record and no longer waits for anything;
 * - a Subscription held by a session in no conversation, such as a Thread's;
 * - a Permission Request's Subscription (target kind `request`), which is
 *   decided once, for the session that asked.
 *
 * `holder_kind` has no CHECK constraint (`0021-subscriptions`), so the new
 * kind needs no table change. The inputs a Subscription already stored keep
 * their `session_id`: they are delivered or cancelled as they were.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE subscriptions
    SET holder_kind = 'conversation',
        holder_id = (SELECT sessions.conversation_id FROM sessions
                     WHERE sessions.id = subscriptions.holder_id)
    WHERE ended_at IS NULL
      AND holder_kind = 'session'
      AND json_extract(target, '$.kind') IS NOT 'request'
      AND EXISTS (SELECT 1 FROM sessions
                  JOIN conversations ON conversations.id = sessions.conversation_id
                  WHERE sessions.id = subscriptions.holder_id)
  `;
});
