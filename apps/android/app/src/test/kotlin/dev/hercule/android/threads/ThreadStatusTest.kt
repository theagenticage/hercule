package dev.hercule.android.threads

import dev.hercule.android.office.AT
import dev.hercule.android.office.buildSession
import dev.hercule.android.wire.SessionStatus
import dev.hercule.android.wire.ThreadDone
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Tests [findResumeBlockedReason] and [isMarkedDone]. The [findResumeBlockedReason] cases are
 * copied one for one from packages/client-core/src/threads/resume-blocked.test.ts. client-core
 * has no test of its own for `isMarkedDone`; its one case here checks both answers.
 */
class ThreadStatusTest {
    @Test
    fun `returns null for a session that has not exited`() {
        assertNull(findResumeBlockedReason(buildSession("s0", status = SessionStatus.Idle)))
        assertNull(findResumeBlockedReason(buildSession("s0", status = SessionStatus.Busy)))
    }

    @Test
    fun `returns null for an exited session that can be resumed`() {
        val exited = buildSession("s0", status = SessionStatus.Exited, resumable = true).copy(nativeSessionId = "n")
        assertNull(findResumeBlockedReason(exited))
    }

    @Test
    fun `says the transcript is gone when a session that cannot be resumed has no native session id`() {
        val exited = buildSession("s0", status = SessionStatus.Exited, resumable = false).copy(nativeSessionId = null)
        assertEquals("its transcript is gone", findResumeBlockedReason(exited))
    }

    @Test
    fun `says the runner was retired when a session that cannot be resumed still has its native session id`() {
        val exited = buildSession("s0", status = SessionStatus.Exited, resumable = false).copy(nativeSessionId = "n")
        assertEquals("its runner was retired", findResumeBlockedReason(exited))
    }

    @Test
    fun `counts a thread as Done only while it carries the Done mark`() {
        assertFalse(isMarkedDone(buildSession("s0")))
        assertTrue(isMarkedDone(buildSession("s0").copy(done = ThreadDone(AT, "user"))))
    }
}
