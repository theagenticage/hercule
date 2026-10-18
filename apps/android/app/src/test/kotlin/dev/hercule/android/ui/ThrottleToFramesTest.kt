package dev.hercule.android.ui

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Test

/** Tests [throttleToFrames]: the first value passes at once, the newest always arrives, and at most one a frame. */
@OptIn(ExperimentalCoroutinesApi::class)
class ThrottleToFramesTest {
    @Test
    fun `passes the first value at once, then the newest one a frame, and never loses the last`() = runTest {
        val arrivals = mutableListOf<Pair<Long, Int>>()
        // A burst of 100 tokens, one a millisecond.
        flow {
            for (token in 1..100) {
                emit(token)
                delay(1)
            }
        }.throttleToFrames().collect { arrivals += currentTime to it }

        val times = arrivals.map { it.first }
        assertEquals(0L to 1, arrivals.first())
        assertEquals(100, arrivals.last().second)
        assertTrue(times.zipWithNext().all { (a, b) -> b - a >= FRAME_MILLIS }, "No two values within a frame: $times")
        // The newest value waits at most a frame after the burst ends.
        assertTrue(times.last() <= 100 + FRAME_MILLIS, "The last value came at ${times.last()} ms")
    }
}
