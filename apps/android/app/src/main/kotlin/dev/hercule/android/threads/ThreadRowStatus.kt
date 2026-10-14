package dev.hercule.android.threads

import dev.hercule.android.faces.Pose
import dev.hercule.android.office.decideThreadPose
import dev.hercule.android.office.isRunnerDisconnected
import dev.hercule.android.wire.Runner
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionStatus

/** What the status slot at the right end of a thread's row shows. */
enum class ThreadRowStatus {
    /** The working mark: a starting or busy thread. */
    Working,

    /**
     * The waiting mark: the thread waits on the user. The desktop tells an approval from a
     * question here; the book draws one mark for both, so the phone does too.
     */
    Waiting,

    /** The word "queued": the thread's runner is connected but full. */
    Queued,

    /** The word "offline": the thread is not exited, and its runner is offline or unreachable. */
    Offline,

    /** How long ago something happened to the thread, as the row decides: its last activity, or when it was marked Done. */
    Age,
}

/**
 * Returns what the status slot of a thread's row shows for [session] on [runner], from the same
 * rules as [decideThreadPose]. A null [runner] counts as connected, as it does there:
 *
 * - a waiting thread shows [ThreadRowStatus.Waiting];
 * - an exited thread shows its age, whatever its runner. It is not running, so a disconnected
 *   runner changes nothing about it until the next message, and its face already says whether
 *   that message can reach it;
 * - a queued, starting, idle or busy thread on an offline or unreachable runner shows
 *   [ThreadRowStatus.Offline];
 * - a queued thread shows [ThreadRowStatus.Queued];
 * - a starting or busy thread shows [ThreadRowStatus.Working];
 * - any other thread, idle or held by the crash-loop guard, shows its age.
 *
 * Ported from `decideThreadRowStatus` in packages/client-core/src/threads/pose.ts, with
 * `decideThreadRowEnd` from the same file folded in, because nothing else here uses it.
 */
fun decideThreadRowStatus(session: Session, runner: Runner?): ThreadRowStatus =
    when (decideThreadPose(session, runner)) {
        Pose.Waiting -> ThreadRowStatus.Waiting
        Pose.Away ->
            if (session.status != SessionStatus.Exited && isRunnerDisconnected(runner)) ThreadRowStatus.Offline else ThreadRowStatus.Age
        Pose.Working ->
            if (session.status == SessionStatus.Queued) ThreadRowStatus.Queued else ThreadRowStatus.Working
        else -> ThreadRowStatus.Age
    }
