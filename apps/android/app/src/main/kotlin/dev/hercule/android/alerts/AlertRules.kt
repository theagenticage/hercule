package dev.hercule.android.alerts

import dev.hercule.android.office.buildAlertBody
import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.ConversationSenderRole
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionStatus
import dev.hercule.android.wire.TranscriptRow
import kotlin.time.Instant
import kotlinx.serialization.Serializable

/** What the app knows now that the alerts are decided from. */
data class AlertSnapshot(
    /** Every thread session (`session.query {thread: true}`). Run sessions are left out here if any slip in. */
    val threads: List<Session>,
    val assistants: List<AssistantAlertSource>,
    /**
     * The transcript of the thread [decideFollowedSessionId] names, in position order, from
     * at least its latest `turn.started` on. Empty when no thread is followed.
     */
    val followedTranscript: List<TranscriptRow>,
    /** The destination on screen now, or null when the app is in the background or elsewhere. */
    val keyOnScreen: AlertKey?,
)

/** One assistant and what its alert is built from. */
data class AssistantAlertSource(
    val assistant: Assistant,
    /** The newest session of the assistant's main Conversation, or null when it has none. */
    val currentSession: Session?,
    /** The newest messages of the main Conversation, in any order. */
    val recentMessages: List<ConversationMessage>,
)

/**
 * What the alert rules remember between lists. It is persisted, so that Android killing the
 * process causes neither an alert storm nor alerts posted twice.
 */
@Serializable
data class AlertMemory(
    /** The open Request ids of each destination in the last list, oldest first, by key id. Only destinations with one. */
    val openRequestIds: Map<String, List<String>> = emptyMap(),
    /** The alerts posted now, by key id. */
    val shownAlerts: Map<String, ShownAlert> = emptyMap(),
    /**
     * The highest message position seen in each assistant's main Conversation, by assistant
     * id. Positions, not message ids, because a position orders messages: an id that has
     * scrolled out of the recent messages could not be placed.
     */
    val lastMessagePositions: Map<String, Long> = emptyMap(),
    /** The session id of the thread whose Live Update shows, or null. */
    val followedSessionId: String? = null,
)

/** A posted alert. [requestId] is the Request it shows, or null for an assistant alert showing messages only. */
@Serializable
data class ShownAlert(val requestId: String?)

/** What to change on screen, and what to remember for the next list. */
data class AlertDecision(
    val memory: AlertMemory,
    val changes: List<AlertChange>,
    /** The Live Update to show, or null when none should show. */
    val liveUpdate: LiveUpdate?,
)

/** One change to one destination's alert. */
sealed interface AlertChange {
    val key: AlertKey

    /** Posts [alert], replacing the destination's alert, with sound or silently. */
    data class Post(val alert: Alert, val withSound: Boolean) : AlertChange {
        override val key: AlertKey get() = alert.key
    }

    /**
     * Replaces the destination's alert with [alert] silently, but only while the alert is
     * still on screen. An alert the user swiped away stays away: its content changed, but
     * nothing new happened.
     */
    data class Refresh(val alert: Alert) : AlertChange {
        override val key: AlertKey get() = alert.key
    }

    /** Removes the destination's alert. */
    data class Remove(override val key: AlertKey) : AlertChange
}

/** An alert's content, drawn as a conversation notification. */
sealed interface Alert {
    val key: AlertKey
    val actions: AlertActions
}

/** A thread's alert about its newest open Request, from the thread's colleague. */
data class ThreadRequestAlert(
    val sessionId: String,
    val threadTitle: String,
    /** `<thread title> · Request`, or `· Question` for a question. */
    val heading: String,
    /** The question, with "+N more waiting" when other Requests wait. */
    val message: String,
    val requestId: String,
    override val actions: AlertActions,
    val at: Instant,
) : Alert {
    override val key: AlertKey get() = ThreadAlertKey(sessionId)
}

/**
 * An assistant's alert: its recent messages and, while one is open, its newest Request as
 * the newest message. Its buttons are the Request's while one is open, and Reply otherwise.
 */
data class AssistantAlert(
    val assistantId: String,
    val assistantName: String,
    val messages: List<AlertMessage>,
    /** The open Request shown as the newest message, or null. */
    val requestId: String?,
    override val actions: AlertActions,
) : Alert {
    override val key: AlertKey get() = AssistantAlertKey(assistantId)
}

/** One message of an [AssistantAlert]. */
data class AlertMessage(val text: String, val fromOwner: Boolean, val at: Instant)

/**
 * Returns the session id of the thread to follow: the thread on screen when there is one,
 * otherwise the one followed before. The followed thread is the thread the user opened last.
 * [decideAlerts] may still end the follow.
 */
fun decideFollowedSessionId(memory: AlertMemory, keyOnScreen: AlertKey?): String? =
    (keyOnScreen as? ThreadAlertKey)?.sessionId ?: memory.followedSessionId

/**
 * Decides which alerts to post, re-post and remove for [snapshot], given [memory] from the
 * last list. [isFirstList] is true for the first list after sign-in, app start or a
 * reconnect: that list records what is open and alerts for nothing, but still removes alerts
 * whose Request was answered meanwhile.
 *
 * - A thread alerts when its newest open Request was not open in the last list. Its alert
 *   replaces any earlier one. When the Request it shows closes, the alert is removed and no
 *   other takes its place, even if older Requests stay open.
 * - An assistant alerts on a new open Request of its current session, and on a new message
 *   from it in its main Conversation. When the Request it shows closes, the alert is shown
 *   again silently, with Reply.
 * - When another of a destination's Requests opens or closes without alerting, its alert is
 *   shown again silently, so that "+N more waiting" stays true. Showing an alert again
 *   never brings back one the user swiped away.
 * - Nothing alerts while its destination is on screen.
 * - The followed thread has no alert of its own: its Live Update alerts once instead. The
 *   Live Update shows only while the thread works or waits on the user, even on screen.
 * - Run sessions and permission requests never alert.
 */
fun decideAlerts(snapshot: AlertSnapshot, memory: AlertMemory, isFirstList: Boolean): AlertDecision {
    val threads = snapshot.threads.filter { it.runId == null }
    val followed = decideFollowedThread(threads, memory, snapshot.keyOnScreen)
    val changes = mutableListOf<AlertChange>()
    val openRequestIds = mutableMapOf<String, List<String>>()
    val shownAlerts = mutableMapOf<String, ShownAlert>()
    val lastMessagePositions = mutableMapOf<String, Long>()
    var liveUpdate: LiveUpdate? = null

    for (session in threads) {
        val key = ThreadAlertKey(session.id)
        val newest = session.openRequests.lastOrNull()
        val isNew = !isFirstList && newest != null &&
            newest.requestId !in memory.openRequestIds[key.id].orEmpty()
        val shown = memory.shownAlerts[key.id]
        if (session.openRequests.isNotEmpty()) openRequestIds[key.id] = session.openRequests.map { it.requestId }

        // A thread on screen is always the followed one, so only its Live Update has to
        // check whether the thread is on screen.
        if (session.id == followed?.id) {
            // The Live Update is the followed thread's one notification. A thread on screen
            // stays followed while idle, but shows a Live Update only while it is live.
            if (shown != null) changes += AlertChange.Remove(key)
            if (isLive(session)) {
                liveUpdate = buildLiveUpdate(session, snapshot.followedTranscript, alert = isNew && snapshot.keyOnScreen != key)
            }
            continue
        }
        val wasFollowed = memory.followedSessionId == session.id
        when {
            isNew -> {
                val alert = buildThreadAlert(session)
                changes += AlertChange.Post(alert, withSound = true)
                shownAlerts[key.id] = ShownAlert(alert.requestId)
            }
            shown != null && shown.requestId !in session.openRequests.map { it.requestId } ->
                changes += AlertChange.Remove(key)
            // Another Request opened or closed: the alert's "+N more waiting" is out of date.
            shown != null && openRequestIds[key.id] != memory.openRequestIds[key.id] -> {
                val alert = buildThreadAlert(session)
                changes += AlertChange.Refresh(alert)
                shownAlerts[key.id] = ShownAlert(alert.requestId)
            }
            shown != null -> shownAlerts[key.id] = shown
            // The user opened another thread while this one still waits. The Requests are
            // not new, but the destination keeps its one notification, so it is posted
            // silently in place of the Live Update.
            wasFollowed && newest != null -> {
                val alert = buildThreadAlert(session)
                changes += AlertChange.Post(alert, withSound = false)
                shownAlerts[key.id] = ShownAlert(alert.requestId)
            }
        }
    }

    for (source in snapshot.assistants) {
        val key = AssistantAlertKey(source.assistant.id)
        val requests = source.currentSession?.openRequests.orEmpty()
        val newest = requests.lastOrNull()
        val isNewRequest = !isFirstList && newest != null &&
            newest.requestId !in memory.openRequestIds[key.id].orEmpty()
        if (requests.isNotEmpty()) openRequestIds[key.id] = requests.map { it.requestId }

        // An assistant seen for the first time after the first list is new: its messages are new too.
        val lastPosition = memory.lastMessagePositions[source.assistant.id] ?: 0
        val hasNewMessage = !isFirstList && source.recentMessages.any {
            it.senderRole == ConversationSenderRole.Assistant && it.position > lastPosition
        }
        lastMessagePositions[source.assistant.id] =
            maxOf(lastPosition, source.recentMessages.maxOfOrNull { it.position } ?: 0)

        val shown = memory.shownAlerts[key.id]
        when {
            (isNewRequest || hasNewMessage) && snapshot.keyOnScreen != key -> {
                changes += AlertChange.Post(buildAssistantAlert(source), withSound = true)
                shownAlerts[key.id] = ShownAlert(newest?.requestId)
            }
            // The user sees the conversation, so its alert has nothing left to tell. This
            // matches a thread, whose alert goes when the thread is opened.
            snapshot.keyOnScreen == key -> if (shown != null) changes += AlertChange.Remove(key)
            // The Request the alert shows has closed, another took its place, or another
            // opened or closed and the count is out of date: show the alert again without
            // sound, with the Request's buttons or with Reply.
            shown != null && (shown.requestId != newest?.requestId || openRequestIds[key.id] != memory.openRequestIds[key.id]) -> {
                changes += AlertChange.Refresh(buildAssistantAlert(source))
                shownAlerts[key.id] = ShownAlert(newest?.requestId)
            }
            shown != null -> shownAlerts[key.id] = shown
        }
    }

    // A destination that left the lists, such as a deleted thread, loses its alert.
    val listedKeys = threads.map { ThreadAlertKey(it.id).id } + snapshot.assistants.map { AssistantAlertKey(it.assistant.id).id }
    for (keyId in memory.shownAlerts.keys - listedKeys.toSet()) {
        changes += AlertChange.Remove(checkNotNull(AlertKey.parse(keyId)))
    }

    return AlertDecision(
        memory = AlertMemory(openRequestIds, shownAlerts, lastMessagePositions, followed?.id),
        changes = changes,
        liveUpdate = liveUpdate,
    )
}

/**
 * Returns the followed thread, or null when none is followed. A thread stays followed while
 * it works or waits on the user, and while it is on screen. It stops being followed when it
 * goes idle or ends off screen, or when the user opens another thread.
 */
private fun decideFollowedThread(threads: List<Session>, memory: AlertMemory, keyOnScreen: AlertKey?): Session? {
    val sessionId = decideFollowedSessionId(memory, keyOnScreen) ?: return null
    val session = threads.find { it.id == sessionId } ?: return null
    return session.takeIf { isLive(it) || keyOnScreen == ThreadAlertKey(sessionId) }
}

/** Checks whether [session] works or waits on the user: only then does it show a Live Update. */
private fun isLive(session: Session): Boolean =
    session.openRequests.isNotEmpty() || session.status in WORKING_STATUSES

/** The statuses in which a session is working: anything but idle and exited. */
private val WORKING_STATUSES = setOf(SessionStatus.Queued, SessionStatus.Starting, SessionStatus.Busy)

/** Builds a thread's alert about its newest open Request. Fails when nothing is open. */
private fun buildThreadAlert(session: Session): ThreadRequestAlert {
    val newest = session.openRequests.last()
    return ThreadRequestAlert(
        sessionId = session.id,
        threadTitle = session.title,
        heading = "${session.title} · ${if (newest is QuestionRequest) "Question" else "Request"}",
        message = buildAlertBody(session.openRequests),
        requestId = newest.requestId,
        actions = decideAlertActions(session.id, newest),
        at = session.lastActivityAt,
    )
}

/**
 * Builds an assistant's alert: its last [MAX_ALERT_MESSAGES] messages, owner and assistant,
 * in order, then its newest open Request as the newest message.
 */
private fun buildAssistantAlert(source: AssistantAlertSource): AssistantAlert {
    val messages = source.recentMessages
        .filter { it.senderRole == ConversationSenderRole.Owner || it.senderRole == ConversationSenderRole.Assistant }
        .sortedBy { it.position }
        .takeLast(MAX_ALERT_MESSAGES)
        .map { AlertMessage(it.text, fromOwner = it.senderRole == ConversationSenderRole.Owner, at = it.createdAt) }
    val session = source.currentSession
    val newest = session?.openRequests?.lastOrNull()
    if (session == null || newest == null) {
        return AssistantAlert(
            assistantId = source.assistant.id,
            assistantName = source.assistant.name,
            messages = messages,
            requestId = null,
            actions = AlertActions.Reply(source.assistant.mainConversationId),
        )
    }
    val requestMessage = AlertMessage(
        text = buildAlertBody(session.openRequests),
        fromOwner = false,
        // The Request is the newest message, so it never sorts before the last one.
        at = maxOf(session.lastActivityAt, messages.lastOrNull()?.at ?: session.lastActivityAt),
    )
    return AssistantAlert(
        assistantId = source.assistant.id,
        assistantName = source.assistant.name,
        messages = messages + requestMessage,
        requestId = newest.requestId,
        actions = decideAlertActions(session.id, newest),
    )
}

/** An assistant alert shows this many recent messages at most. */
private const val MAX_ALERT_MESSAGES = 6
