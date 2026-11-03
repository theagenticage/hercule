/**
 * The refusal every operation gives an archived session. An archived Thread is
 * final: it takes no input and is never resumed or forked (spec 11, section
 * 2, `session.archive`).
 */
import * as Effect from "effect/Effect";
import { createInvalidStateError, type InvalidState } from "@hercule/contract";
import type { StoredSession } from "./repository";

/** The message of `InvalidState` for a session that takes no input or fork because it is archived. */
export const ARCHIVED_REFUSAL =
  "This thread is archived, so it cannot take input or be reopened. Start a new thread to carry on.";

/**
 * Checks that the session is not archived. Fails with `InvalidState`
 * carrying `ARCHIVED_REFUSAL` when it is, and succeeds with nothing otherwise.
 * Every operation that would give an archived session input, a change or a
 * second life calls this before it writes. Reading the session and its
 * transcript stays allowed, so those do not call it.
 */
export const refuseArchived = (
  session: Pick<StoredSession, "archived">,
): Effect.Effect<void, InvalidState> =>
  session.archived === null ? Effect.void : Effect.fail(createInvalidStateError(ARCHIVED_REFUSAL));
