package dev.hercule.android.office

import dev.hercule.android.faces.Pose
import dev.hercule.android.wire.Runner
import dev.hercule.android.wire.RunnerConnectivity
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionStatus

/**
 * Returns the pose of a thread whose session is [session], on [runner]. The first rule that
 * matches decides:
 *
 * - an open Request makes it [Pose.Waiting], whichever of the session's agents asked, even while
 *   its own agent is idle. An exited session never has one, so this never hides an ended thread;
 * - a session that cannot be resumed, or that the crash-loop guard holds, is [Pose.Away]
 *   ("can't be reached"), because neither runs until the user acts;
 * - a session whose runner is offline or unreachable is [Pose.Away], because no message reaches
 *   it until the runner returns. A null [runner], one missing from the runners list, counts as
 *   connected: a list that has not caught up is no evidence that the machine is gone;
 * - an exited session that the next message resumes is [Pose.Asleep];
 * - an idle session is [Pose.Idle];
 * - a queued, starting or busy session is [Pose.Working].
 *
 * Failed, paused and done are never returned: the session record does not say why a session
 * ended, so nothing can claim any of them.
 *
 * Ported from `decideThreadPose` in packages/client-core/src/threads/pose.ts.
 */
fun decideThreadPose(session: Session, runner: Runner?): Pose = when {
    session.openRequests.isNotEmpty() -> Pose.Waiting
    isStoppedUntilUserActs(session) || isRunnerDisconnected(runner) -> Pose.Away
    session.status == SessionStatus.Exited -> Pose.Asleep
    session.status == SessionStatus.Idle -> Pose.Idle
    else -> Pose.Working
}

/**
 * Returns the pose of an assistant whose main conversation's current session is [session], on
 * [runner]. With no session yet the pose is [Pose.Idle]: the assistant waits for its first
 * message. Otherwise it is a thread's pose, so an assistant and a thread in the same state show
 * the same face.
 *
 * Ported from `decideAssistantPose` in packages/client-core/src/assistants/rows.ts.
 */
fun decideAssistantPose(session: Session?, runner: Runner?): Pose =
    if (session == null) Pose.Idle else decideThreadPose(session, runner)

/**
 * Checks whether the session cannot run again until the user acts: it has exited and cannot be
 * resumed, or the crash-loop guard holds it.
 */
private fun isStoppedUntilUserActs(session: Session): Boolean =
    session.resumeHeld || (session.status == SessionStatus.Exited && !session.resumable)

/** Checks whether [runner] is known to be disconnected. A null runner counts as connected. */
internal fun isRunnerDisconnected(runner: Runner?): Boolean =
    runner != null && runner.connectivity != RunnerConnectivity.Online
