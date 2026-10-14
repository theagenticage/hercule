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
import { EditOverlapService } from "../../edit-overlaps";
import { SessionEditObserver } from "../../sessions";
import { makeForkAfterCommit } from "../sessions";
import { DiscussionInputs } from "./discussion-inputs";

/**
 * The sessions domain's `SessionEditObserver`, set once it is built.
 *
 * The session service needs the observer, and the observer needs
 * `DiscussionInputs`, which needs the session service. So boot builds the
 * observer's layer with this empty reference, and `SessionEditObserverFill`
 * sets it once `DiscussionInputs` is built. Boot builds every layer before it
 * serves any request or hears from any runner, so no session changes before
 * the reference is set.
 */
export class SessionEditObserverReference extends Context.Service<
  SessionEditObserverReference,
  {
    /** Sets the reference. Called once, by `SessionEditObserverFill`. */
    readonly set: (observer: SessionEditObserver["Service"]) => void;
    /** Returns the observer. Dies when it is not set yet, which is a bug in boot. */
    readonly get: Effect.Effect<SessionEditObserver["Service"]>;
  }
>()("hercule/controller/daemon/SessionEditObserverReference") {}

export const SessionEditObserverReferenceLayer: Layer.Layer<SessionEditObserverReference> =
  Layer.sync(SessionEditObserverReference)(() => {
    let observer: SessionEditObserver["Service"] | undefined;
    return {
      set: (built) => {
        observer = built;
      },
      get: Effect.suspend(() =>
        observer === undefined
          ? Effect.die(
              "A session's edits were reported before the edit overlap observer was built. Boot must build DiscussionInputs, and SessionEditObserverFill with it, before any session can change.",
            )
          : Effect.succeed(observer),
      ),
    };
  });

/** Provides `SessionEditObserver` to the session service, through the reference. */
export const SessionEditObserverLayer: Layer.Layer<
  SessionEditObserver,
  never,
  SessionEditObserverReference
> = Layer.effect(SessionEditObserver)(
  Effect.gen(function* () {
    const reference = yield* SessionEditObserverReference;
    return SessionEditObserver.of({
      filesEdited: (sessionId, files) =>
        Effect.flatMap(reference.get, (observer) => observer.filesEdited(sessionId, files)),
      becameUnfinishedAgain: (sessionId) =>
        Effect.flatMap(reference.get, (observer) => observer.becameUnfinishedAgain(sessionId)),
    });
  }),
);

/**
 * Sets `SessionEditObserverReference` to the observer that records the edits
 * in the edit overlaps domain, and tells each session that gained an entry
 * once the caller's transaction commits. A tell that is lost does no harm:
 * the entry is stored as pending, so the end of the session's next turn tells
 * it. `tellSession` passes the promotion gate itself.
 */
export const SessionEditObserverFill: Layer.Layer<
  never,
  never,
  SessionEditObserverReference | EditOverlapService | DiscussionInputs
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const reference = yield* SessionEditObserverReference;
    const overlaps = yield* EditOverlapService;
    const { tellSession } = yield* DiscussionInputs;
    const forkAfterCommit = yield* makeForkAfterCommit;

    const tellEntries = (sessionIds: ReadonlyArray<string>) =>
      Effect.forEach(
        sessionIds,
        (sessionId) =>
          forkAfterCommit(
            "A session was not told about an Edit Overlap",
            tellSession(sessionId, "entry"),
          ),
        { discard: true },
      );

    reference.set(
      SessionEditObserver.of({
        filesEdited: (sessionId, files) =>
          Effect.flatMap(overlaps.recordEdits(sessionId, files), tellEntries),
        becameUnfinishedAgain: (sessionId) =>
          Effect.flatMap(overlaps.rejoinOverlaps(sessionId), tellEntries),
      }),
    );
  }),
);
