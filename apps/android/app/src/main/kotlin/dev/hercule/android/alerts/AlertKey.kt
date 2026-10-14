package dev.hercule.android.alerts

/**
 * The destination an alert is about: a thread or an assistant. Each destination has at most
 * one alert, and [id] is both that alert's tag and the id of the destination's long-lived
 * shortcut.
 */
sealed interface AlertKey {
    /** `thread:<sessionId>` or `assistant:<assistantId>`, the same keys the desktop uses. */
    val id: String

    companion object {
        /** Parses an id that [AlertKey.id] wrote, or returns null for any other text. */
        fun parse(id: String): AlertKey? = when {
            id.startsWith(THREAD_PREFIX) -> ThreadAlertKey(id.removePrefix(THREAD_PREFIX))
            id.startsWith(ASSISTANT_PREFIX) -> AssistantAlertKey(id.removePrefix(ASSISTANT_PREFIX))
            else -> null
        }
    }
}

/** The key of a thread's Live Update, its one notification. */
data class ThreadAlertKey(val sessionId: String) : AlertKey {
    override val id: String get() = THREAD_PREFIX + sessionId
}

/** The key of an assistant's alert, which holds both its messages and its Requests. */
data class AssistantAlertKey(val assistantId: String) : AlertKey {
    override val id: String get() = ASSISTANT_PREFIX + assistantId
}

private const val THREAD_PREFIX = "thread:"
private const val ASSISTANT_PREFIX = "assistant:"
