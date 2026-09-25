/**
 * The rule for which session answers a conversation right now: the newest
 * session made for the conversation. Older sessions stay as history.
 */
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { CursorError } from "../db";
import type { SessionRows, StoredSession } from "../sessions";

/**
 * Reads the conversation's current session, its newest, from the session
 * rows. Returns none when no session was ever made for the conversation.
 * Joins the caller's transaction when there is one.
 */
export const readCurrentSession = (
  rows: SessionRows,
  conversationId: string,
): Effect.Effect<Option.Option<StoredSession>, SqlError> =>
  Effect.map(
    Effect.catchIf(
      rows.list({
        limit: 1,
        cursor: undefined,
        direction: "desc",
        status: undefined,
        runnerId: undefined,
        agentId: undefined,
        permissionProfileId: undefined,
        conversationId,
        thread: undefined,
      }),
      (error): error is CursorError => error instanceof CursorError,
      // The list is read from its start, with no cursor to reject.
      (error) => Effect.die(error),
    ),
    (page) => Array.head(page.items),
  );
