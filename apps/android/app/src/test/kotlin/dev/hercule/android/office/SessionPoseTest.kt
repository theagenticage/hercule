package dev.hercule.android.office

import dev.hercule.android.faces.Pose
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.RunnerConnectivity
import dev.hercule.android.wire.SessionStatus
import kotlin.test.assertEquals
import org.junit.Test

/**
 * Tests [decideThreadPose]. The cases are copied one for one from
 * packages/client-core/src/threads/pose.test.ts, keeping only the pose each one asserts: the
 * source also asserts `decideThreadRowEnd`, which the app does not port. The pose words are
 * tested with [Pose] in the faces package.
 */
class SessionPoseTest {
    private val request = buildCommandRequest("req-1", "git push")
    private val online = buildRunner(MOSS_ID, "moss")
    private val offline = buildRunner(MOSS_ID, "moss", connectivity = RunnerConnectivity.Offline)
    private val unreachable = buildRunner(MOSS_ID, "moss", connectivity = RunnerConnectivity.Unreachable)

    @Test
    fun `shows a thread with an open request as waiting`() {
        assertEquals(Pose.Waiting, decideThreadPose(buildSession("s-1", status = SessionStatus.Busy, openRequests = listOf(request)), online))
    }

    @Test
    fun `shows a busy thread with an async question as waiting on the user, though its agent keeps working`() {
        val asked = QuestionRequest("req-1", "item-1", QuestionRequest.Detail(emptyList()), async = true)
        assertEquals(Pose.Waiting, decideThreadPose(buildSession("s-1", status = SessionStatus.Busy, openRequests = listOf(asked)), online))
    }

    @Test
    fun `keeps a thread waiting when its runner is offline, because the request comes first`() {
        assertEquals(Pose.Waiting, decideThreadPose(buildSession("s-1", status = SessionStatus.Busy, openRequests = listOf(request)), offline))
    }

    @Test
    fun `shows a thread as waiting when only one of its subagents asked`() {
        val asked = buildSession(
            "s-1",
            status = SessionStatus.Busy,
            openRequests = listOf(buildCommandRequest("req-1", "git push", subagentId = "a-1")),
        )
        assertEquals(Pose.Waiting, decideThreadPose(asked, online))
    }

    @Test
    fun `shows a held session as away`() {
        assertEquals(
            Pose.Away,
            decideThreadPose(buildSession("s-1", status = SessionStatus.Exited, resumable = true, resumeHeld = true), online),
        )
    }

    @Test
    fun `shows an exited session that cannot be resumed as away`() {
        assertEquals(Pose.Away, decideThreadPose(buildSession("s-1", status = SessionStatus.Exited), online))
    }

    @Test
    fun `keeps a thread that cannot be resumed away even when its runner is offline`() {
        assertEquals(Pose.Away, decideThreadPose(buildSession("s-1", status = SessionStatus.Exited), offline))
    }

    @Test
    fun `shows a queued, starting, idle or busy session on a disconnected runner as away`() {
        for (status in listOf(SessionStatus.Queued, SessionStatus.Starting, SessionStatus.Idle, SessionStatus.Busy)) {
            for (runner in listOf(offline, unreachable)) {
                assertEquals(Pose.Away, decideThreadPose(buildSession("s-1", status = status), runner), "${status.wire} ${runner.connectivity.wire}")
            }
        }
    }

    @Test
    fun `shows an exited resumable session on a disconnected runner as away`() {
        for (runner in listOf(offline, unreachable)) {
            assertEquals(Pose.Away, decideThreadPose(buildSession("s-1", status = SessionStatus.Exited, resumable = true), runner))
        }
    }

    @Test
    fun `shows an exited resumable session as asleep`() {
        assertEquals(Pose.Asleep, decideThreadPose(buildSession("s-1", status = SessionStatus.Exited, resumable = true), online))
    }

    @Test
    fun `shows a queued session as working`() {
        assertEquals(Pose.Working, decideThreadPose(buildSession("s-1", status = SessionStatus.Queued), online))
    }

    @Test
    fun `shows a starting or busy session as working`() {
        for (status in listOf(SessionStatus.Starting, SessionStatus.Busy)) {
            assertEquals(Pose.Working, decideThreadPose(buildSession("s-1", status = status), online))
        }
    }

    @Test
    fun `shows an idle session as idle`() {
        assertEquals(Pose.Idle, decideThreadPose(buildSession("s-1", status = SessionStatus.Idle), online))
    }

    // A runner missing from the runners list is a cache that has not caught up, not evidence
    // that the machine is gone.
    @Test
    fun `treats a runner that is not in the runners list as connected`() {
        assertEquals(Pose.Working, decideThreadPose(buildSession("s-1", status = SessionStatus.Busy), null))
        assertEquals(Pose.Asleep, decideThreadPose(buildSession("s-1", status = SessionStatus.Exited, resumable = true), null))
    }
}
