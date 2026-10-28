/**
 * Putting sessions that edited the same file into one Discussion, and telling
 * the sessions that gained an entry (spec 19 sections 4 and 5.3).
 *
 * The edit overlaps domain records the edits and the joins in the transaction
 * of the report, and returns the sessions that gained a pending entry. Telling
 * them waits on a runner, so it happens here, after the commit.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import { DiscussionServiceLayer } from "../../discussions";
import { EditOverlapService, EditOverlapServiceLayer } from "../../edit-overlaps";
import type { AuditLog } from "../../events";
import { SessionEditObserver } from "../../sessions";
import { makeLateReference, type LateReference } from "../late-reference";
import { makeForkAfterCommit } from "../sessions";
import { DiscussionInputs } from "./discussion-inputs";

/**
 * `DiscussionInputs`, set once it is built.
 *
 * The session service needs the edit observer, which tells the sessions that
 * gained an entry through `DiscussionInputs`, and `DiscussionInputs` needs the
 * session service. So boot builds the observer with this empty reference, and
 * `DiscussionInputsReferenceFill` sets it once `DiscussionInputs` is built.
 */
export class DiscussionInputsReference extends Context.Service<
  DiscussionInputsReference,
  LateReference<DiscussionInputs["Service"]>
>()("hercule/controller/daemon/DiscussionInputsReference") {}

export const DiscussionInputsReferenceLayer: Layer.Layer<DiscussionInputsReference> = Layer.sync(
  DiscussionInputsReference,
)(() =>
  makeLateReference(
    "A session's edits were reported before DiscussionInputs was built. Boot must build DiscussionInputs, and DiscussionInputsReferenceFill with it, before any session can change.",
  ),
);

/** Sets `DiscussionInputsReference` to `DiscussionInputs`, once both are built. */
export const DiscussionInputsReferenceFill: Layer.Layer<
  never,
  never,
  DiscussionInputsReference | DiscussionInputs
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const reference = yield* DiscussionInputsReference;
    reference.set(yield* DiscussionInputs);
  }),
);

/**
 * Provides `SessionEditObserver` to the session service. It records the edits
 * in the edit overlaps domain, and tells each session that gained an entry
 * once the caller's transaction commits. A tell that is lost does no harm:
 * the entry is stored as pending, so the end of the session's next turn tells
 * it. `tellSession` passes the promotion gate itself.
 */
export const SessionEditObserverLayer: Layer.Layer<
  SessionEditObserver,
  never,
  DiscussionInputsReference | SqlClient.SqlClient | AuditLog
> = Layer.effect(SessionEditObserver)(
  Effect.gen(function* () {
    const reference = yield* DiscussionInputsReference;
    const overlaps = yield* EditOverlapService;
    const forkAfterCommit = yield* makeForkAfterCommit;

    const tellEntries = (sessionIds: ReadonlyArray<string>) =>
      Effect.forEach(
        sessionIds,
        (sessionId) =>
          forkAfterCommit(
            "A session was not told about an Edit Overlap",
            Effect.flatMap(reference.get, (inputs) => inputs.tellSession(sessionId, "entry")),
          ),
        { discard: true },
      );

    return SessionEditObserver.of({
      filesEdited: (sessionId, files) =>
        Effect.flatMap(overlaps.recordEdits(sessionId, files), tellEntries),
      becameUnfinishedAgain: (sessionId) =>
        Effect.flatMap(overlaps.rejoinOverlaps(sessionId), tellEntries),
    });
  }),
).pipe(Layer.provide(EditOverlapServiceLayer), Layer.provide(DiscussionServiceLayer));
