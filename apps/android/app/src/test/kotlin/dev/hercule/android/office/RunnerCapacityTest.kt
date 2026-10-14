package dev.hercule.android.office

import dev.hercule.android.wire.SessionStatus
import kotlin.test.assertEquals
import org.junit.Test

/** Tests [describeCapacity]. The cases are copied one for one from packages/client-core/src/runner-capacity.test.ts. */
class RunnerCapacityTest {
    private val moss = buildRunner("01a06d02-beff-7037-9f5b-042822015952", "moss", maxConcurrentSessions = 2)
    private var next = 0

    /** Returns a session with the given status; no other field matters here. */
    private fun buildSessionWith(status: SessionStatus) = buildSession(id = "s-${++next}", status = status, runnerId = moss.id)

    @Test
    fun `shows how many slots are in use and how many sessions are waiting`() {
        assertEquals(
            "1 running of 2 · 2 queued",
            describeCapacity(moss, listOf(buildSessionWith(SessionStatus.Busy), buildSessionWith(SessionStatus.Queued), buildSessionWith(SessionStatus.Queued))),
        )
    }

    @Test
    fun `leaves out the queue when it is empty`() {
        assertEquals("1 running of 2", describeCapacity(moss, listOf(buildSessionWith(SessionStatus.Busy))))
    }

    @Test
    fun `counts one waiting session too`() {
        assertEquals(
            "1 running of 2 · 1 queued",
            describeCapacity(moss, listOf(buildSessionWith(SessionStatus.Busy), buildSessionWith(SessionStatus.Queued))),
        )
    }

    // Starting and idle hold a slot just as busy does: the controller counts all three against
    // the limit, so counting only busy would show a full runner as having room.
    @Test
    fun `counts a session as running from starting until it exits`() {
        assertEquals(
            "3 running of 2",
            describeCapacity(moss, listOf(buildSessionWith(SessionStatus.Starting), buildSessionWith(SessionStatus.Idle), buildSessionWith(SessionStatus.Busy))),
        )
    }

    @Test
    fun `counts an exited session as neither running nor queued`() {
        assertEquals("0 running of 2", describeCapacity(moss, listOf(buildSessionWith(SessionStatus.Exited), buildSessionWith(SessionStatus.Exited))))
    }

    @Test
    fun `shows zero running for a runner with no sessions`() {
        assertEquals("0 running of 2", describeCapacity(moss, emptyList()))
    }

    @Test
    fun `reads the maximum from the given runner`() {
        assertEquals("1 running of 7", describeCapacity(moss.copy(maxConcurrentSessions = 7), listOf(buildSessionWith(SessionStatus.Busy))))
    }
}
