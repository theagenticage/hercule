/**
 * The port through which the sessions domain tells another domain which files
 * its sessions edited, so that two unfinished sessions that edited the same
 * file can be put into one Discussion (spec 19 section 4).
 *
 * It is declared here, in the sessions domain's own words, and implemented by
 * the edit overlaps domain, which imports the discussions domain, which
 * imports this one. So this domain never imports that domain. Boot provides
 * the implementation.
 *
 * It is separate from `SessionObserver` on purpose: that port skips a
 * subagent's events, and an edit by a subagent counts as an edit by its
 * session.
 *
 * Both methods are called by `SessionService` itself, inside the transaction
 * that made the change they report, so a failure in the implementation rolls
 * the change back, and the implementation must not wait on anything outside
 * the database:
 *
 * - `filesEdited` by the one step that applies a runner's report, for every
 *   finished edit it carries, whether or not the session has exited;
 * - `becameUnfinishedAgain` by the steps that make a finished session count
 *   again: reopening a Thread, and resuming a session that no Agent step or
 *   Thread owns.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { EditedFile } from "@hercule/protocol";

/** The party told which files every session edits. */
export class SessionEditObserver extends Context.Service<
  SessionEditObserver,
  {
    /**
     * Handles one report in which the session finished editing `files`. The
     * files are never empty.
     */
    readonly filesEdited: (
      sessionId: string,
      files: ReadonlyArray<EditedFile>,
    ) => Effect.Effect<void, SqlError>;
    /**
     * Handles a session that counts as unfinished again after it did not: its
     * earlier edits may now overlap those of other unfinished sessions.
     */
    readonly becameUnfinishedAgain: (sessionId: string) => Effect.Effect<void, SqlError>;
  }
>()("hercule/controller/sessions/SessionEditObserver") {}
