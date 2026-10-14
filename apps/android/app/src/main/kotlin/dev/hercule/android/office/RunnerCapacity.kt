package dev.hercule.android.office

import dev.hercule.android.wire.Runner
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionStatus

/**
 * The statuses that hold one of a runner's session slots. A session holds its slot from
 * starting through busy, because the controller frees the slot only when the session exits.
 */
private val slotHoldingStatuses = setOf(SessionStatus.Starting, SessionStatus.Idle, SessionStatus.Busy)

/**
 * Returns a runner's capacity line, for example `2 running of 4 · 1 queued`: how many of its
 * session slots [sessions] hold, and how many of them wait for one. Only queued sessions wait,
 * and exited sessions are counted in neither. The queue is left out when it is empty.
 *
 * Ported from `describeCapacity` in packages/client-core/src/runner-capacity.ts.
 */
fun describeCapacity(runner: Runner, sessions: List<Session>): String {
    val running = sessions.count { it.status in slotHoldingStatuses }
    val queued = sessions.count { it.status == SessionStatus.Queued }
    val line = "$running running of ${runner.maxConcurrentSessions}"
    return if (queued == 0) line else "$line · $queued queued"
}
