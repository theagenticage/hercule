package dev.hercule.android.threads

import dev.hercule.android.office.MOSS_ID
import dev.hercule.android.office.buildCommandRequest
import dev.hercule.android.office.buildRunner
import dev.hercule.android.office.buildSession
import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.RunnerConnectivity
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.SessionStatus
import kotlin.test.assertEquals
import org.junit.Test

/**
 * Tests [decideThreadRowStatus]. The cases are copied one for one from
 * packages/client-core/src/threads/pose.test.ts: the `decideThreadRowStatus` cases, and the
 * `decideThreadRowEnd` cases, which this port folds in. A row end's waiting mark reads here as
 * [ThreadRowStatus.Approval], because those cases ask with a command approval; the source's
 * poses are tested in office/SessionPoseTest.kt.
 */
class ThreadRowStatusTest {
    private val request = buildCommandRequest("req-1", "git push")
    private val question = QuestionRequest(
        requestId = "req-2",
        itemId = "tool-1",
        detail = QuestionRequest.Detail(listOf(Question("Which one?", "Pick", emptyList(), multiSelect = false))),
    )
    private val online = buildRunner(MOSS_ID, "moss")
    private val offline = buildRunner(MOSS_ID, "moss", connectivity = RunnerConnectivity.Offline)
    private val unreachable = buildRunner(MOSS_ID, "moss", connectivity = RunnerConnectivity.Unreachable)

    @Test
    fun `shows a thread with an open request with the waiting mark`() {
        assertEquals(ThreadRowStatus.Approval, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Busy, openRequests = listOf(request)), online))
    }

    @Test
    fun `keeps a thread waiting when its runner is offline, because the request comes first`() {
        assertEquals(ThreadRowStatus.Approval, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Busy, openRequests = listOf(request)), offline))
    }

    @Test
    fun `shows a thread as waiting when only one of its subagents asked`() {
        val asked = buildSession(
            "s-1",
            status = SessionStatus.Busy,
            openRequests = listOf(buildCommandRequest("req-1", "git push", subagentId = "a-1")),
        )
        assertEquals(ThreadRowStatus.Approval, decideThreadRowStatus(asked, online))
    }

    @Test
    fun `shows a held session with its age`() {
        assertEquals(
            ThreadRowStatus.Age,
            decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Exited, resumable = true, resumeHeld = true), online),
        )
    }

    @Test
    fun `shows an exited session that cannot be resumed with its age and no mark`() {
        assertEquals(ThreadRowStatus.Age, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Exited), online))
    }

    @Test
    fun `keeps the age of a thread that cannot be resumed even when its runner is offline`() {
        assertEquals(ThreadRowStatus.Age, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Exited), offline))
    }

    @Test
    fun `shows a queued, starting, idle or busy session on a disconnected runner with the word offline`() {
        // A queued session shows "offline", not "queued": the runner being gone matters more
        // than the runner being full.
        for (status in listOf(SessionStatus.Queued, SessionStatus.Starting, SessionStatus.Idle, SessionStatus.Busy)) {
            for (runner in listOf(offline, unreachable)) {
                assertEquals(
                    ThreadRowStatus.Offline,
                    decideThreadRowStatus(buildSession("s-1", status = status), runner),
                    "${status.wire} ${runner.connectivity.wire}",
                )
            }
        }
    }

    @Test
    fun `shows an exited resumable session on a disconnected runner with its age`() {
        for (runner in listOf(offline, unreachable)) {
            assertEquals(ThreadRowStatus.Age, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Exited, resumable = true), runner))
        }
    }

    @Test
    fun `shows an exited resumable session with its age`() {
        assertEquals(ThreadRowStatus.Age, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Exited, resumable = true), online))
    }

    @Test
    fun `shows a queued session with the word queued`() {
        assertEquals(ThreadRowStatus.Queued, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Queued), online))
    }

    @Test
    fun `shows a starting or busy session with the working mark`() {
        for (status in listOf(SessionStatus.Starting, SessionStatus.Busy)) {
            assertEquals(ThreadRowStatus.Working, decideThreadRowStatus(buildSession("s-1", status = status), online))
        }
    }

    @Test
    fun `shows an idle session with its age`() {
        assertEquals(ThreadRowStatus.Age, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Idle), online))
    }

    // A runner missing from the runners list is a cache that has not caught up, not evidence
    // that the machine is gone.
    @Test
    fun `treats a runner that is not in the runners list as connected`() {
        assertEquals(ThreadRowStatus.Working, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Busy), null))
        assertEquals(ThreadRowStatus.Age, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Exited, resumable = true), null))
    }

    @Test
    fun `names a waiting thread's oldest request - a question, or else an approval`() {
        fun decide(openRequests: List<SessionRequest>) =
            decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Busy, openRequests = openRequests), online)
        assertEquals(ThreadRowStatus.Question, decide(listOf(question, request)))
        assertEquals(ThreadRowStatus.Approval, decide(listOf(request, question)))
    }

    @Test
    fun `keeps the working, queued, offline and age ends of decideThreadRowEnd`() {
        assertEquals(ThreadRowStatus.Working, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Busy), online))
        assertEquals(ThreadRowStatus.Queued, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Queued), online))
        assertEquals(ThreadRowStatus.Offline, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Idle), offline))
        assertEquals(ThreadRowStatus.Age, decideThreadRowStatus(buildSession("s-1", status = SessionStatus.Idle), online))
    }
}
