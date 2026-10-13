package dev.hercule.android.office

import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionRequest
import kotlin.time.Instant

/**
 * A thread or an assistant waiting on the user, and the Requests its session waits on. Every
 * place that shows what waits (Waiting on you, the Request alerts) reads one list of these, so
 * they always agree.
 *
 * Each entry carries two views of the open Requests:
 *
 * - a row shows the oldest Request ([requestId], [question]);
 * - an alert shows the newest, the one that just opened ([newestRequestId], [alertBody]), and
 *   counts the others.
 *
 * Ported from `Waiting` in packages/client-core/src/waiting.ts, where [alertBody] is called
 * `notificationBody`.
 */
sealed interface Waiting {
    /** The session that asks: the thread's own, or the assistant's current session. */
    val sessionId: String

    /** The oldest open Request's id. When it is answered, the next oldest takes its place. */
    val requestId: String

    /** What the oldest Request asks, in one line, such as "Run git push?". */
    val question: String

    /** The newest open Request's id: the Request the alert shows. */
    val newestRequestId: String

    /** The ids of every open Request, oldest first. */
    val openRequestIds: List<String>

    /**
     * The text of the alert, built from the newest Request, such as "Run git push?" or
     * "Review the diff asks: Run pnpm test?\n+1 more waiting".
     */
    val alertBody: String

    /** When the session was last active. */
    val activityAt: Instant
}

/** A thread waiting on the user. */
data class WaitingThread(
    override val sessionId: String,
    override val requestId: String,
    val title: String,
    override val question: String,
    override val newestRequestId: String,
    override val openRequestIds: List<String>,
    override val alertBody: String,
    override val activityAt: Instant,
) : Waiting

/** An assistant waiting on the user. */
data class WaitingAssistant(
    val assistantId: String,
    val name: String,
    override val sessionId: String,
    override val requestId: String,
    override val question: String,
    override val newestRequestId: String,
    override val openRequestIds: List<String>,
    override val alertBody: String,
    override val activityAt: Instant,
) : Waiting

/**
 * Returns every thread in [threads] and every assistant in [assistants] whose session has an
 * open Request. An assistant's session is its entry in [currentSessions], keyed by assistant
 * id: the current session of its main conversation. An assistant missing from the map has no
 * session and waits on nothing.
 *
 * The list is sorted with the most recently active first, threads and assistants mixed, and two
 * entries active at the same moment by session id.
 *
 * [threads] should hold no run sessions: the desktop keeps them out of Waiting on you's count
 * and out of alerts (wire doc §C).
 *
 * Ported from `listWaiting` in packages/client-core/src/waiting.ts. The source takes the
 * sidebar's assistant rows; this port takes the assistants and their sessions instead.
 */
fun listWaiting(
    threads: List<Session>,
    assistants: List<Assistant>,
    currentSessions: Map<String, Session>,
): List<Waiting> {
    val waitingThreads = threads.mapNotNull { session ->
        val oldest = session.openRequests.firstOrNull() ?: return@mapNotNull null
        WaitingThread(
            sessionId = session.id,
            requestId = oldest.requestId,
            title = session.title,
            question = formatRequestQuestion(oldest),
            newestRequestId = session.openRequests.last().requestId,
            openRequestIds = session.openRequests.map { it.requestId },
            alertBody = buildAlertBody(session.openRequests),
            activityAt = session.lastActivityAt,
        )
    }
    val waitingAssistants = assistants.mapNotNull { assistant ->
        val session = currentSessions[assistant.id] ?: return@mapNotNull null
        val oldest = session.openRequests.firstOrNull() ?: return@mapNotNull null
        WaitingAssistant(
            assistantId = assistant.id,
            name = assistant.name,
            sessionId = session.id,
            requestId = oldest.requestId,
            question = formatRequestQuestion(oldest),
            newestRequestId = session.openRequests.last().requestId,
            openRequestIds = session.openRequests.map { it.requestId },
            alertBody = buildAlertBody(session.openRequests),
            activityAt = session.lastActivityAt,
        )
    }
    return (waitingThreads + waitingAssistants).sortedWith(
        compareByDescending<Waiting> { it.activityAt }.thenBy { it.sessionId },
    )
}

/**
 * Returns the text of the alert about the newest of [openRequests], which is never empty:
 *
 * - the Request's question, such as "Run git push?";
 * - starting with the subagent's name, such as "Review the diff asks: ", when a subagent asked
 *   it, or "A subagent asks: " while the subagent has no name yet;
 * - followed by a second line, "+N more waiting", when others are open.
 */
private fun buildAlertBody(openRequests: List<SessionRequest>): String {
    val newest = openRequests.last()
    val asker = if (newest.subagentId == null) "" else "${newest.subagentName ?: "A subagent"} asks: "
    val others = openRequests.size - 1
    val more = if (others == 0) "" else "\n+$others more waiting"
    return "$asker${formatRequestQuestion(newest)}$more"
}
