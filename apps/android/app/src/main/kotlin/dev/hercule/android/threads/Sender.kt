package dev.hercule.android.threads

import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.Session

/** What a sender's name opens when it is tapped. */
sealed interface SenderLink {
    /** The thread of session [sessionId]. */
    data class Thread(val sessionId: String) : SenderLink

    /** The page of the assistant [assistantId]. */
    data class Assistant(val assistantId: String) : SenderLink

    /** Nothing: the sender's session could not be read, or the phone has no screen for it. */
    data object None : SenderLink
}

/**
 * How to show the agent of another session that sent a message into a thread.
 *
 * [name] is the sender's name as it reads on its own, as in a chip: "Ada", "Another agent".
 * [label] is the name as it reads inside a sentence: "Message from Ada", "Message from another
 * agent". The two differ only for a sender that could not be read. [face] is always idle.
 */
data class SenderReading(
    val name: String,
    val label: String,
    val face: OfficeFace,
    val link: SenderLink,
)

/** Who sent a message into a thread, as its bubble draws it. */
sealed interface MessageSender {
    /** The thread's owner, the user. */
    data object Owner : MessageSender

    /** Another session's agent, whose session has not been read yet. */
    data object Unread : MessageSender

    /** Another session's agent, shown as [reading]. */
    data class Agent(val reading: SenderReading) : MessageSender
}

/**
 * Returns how to show the agent of session [senderSessionId] as the sender of a message. A port
 * of `describeSender` in packages/client-core/src/threads/sender.ts, so the phone names a sender
 * as the desktop does. The one difference is the link: the phone opens only the threads it lists
 * and the assistants, so any other session links nowhere.
 *
 * [session] is that session as the app read it, or null when it cannot be read: it was deleted,
 * the user may not read it, or the read failed. [assistants] is the assistant list the app holds.
 * [opensAsThread] is true when the phone lists the session as a thread, so it can open it.
 *
 * - A session that answers the conversation of an assistant in [assistants] is shown as that
 *   assistant: its name, its face with headwear, and a link to its page.
 * - Any other readable session is shown by its title, or by the tail of its id, as "session
 *   7c82ebeb", when the title is empty. It has a thread's face, and links to its thread when
 *   [opensAsThread] is true.
 * - A session that could not be read is "Another agent", with a thread's face from its id and
 *   no link.
 */
fun describeSender(senderSessionId: String, session: Session?, assistants: List<Assistant>, opensAsThread: Boolean): SenderReading {
    if (session == null) {
        return SenderReading("Another agent", "another agent", OfficeFace(senderSessionId, Pose.Idle, isAssistant = false), SenderLink.None)
    }
    val assistant = session.conversationId?.let { assistants.find { candidate -> candidate.id == session.agentId } }
    if (assistant != null) {
        return SenderReading(assistant.name, assistant.name, OfficeFace(assistant.id, Pose.Idle, isAssistant = true), SenderLink.Assistant(assistant.id))
    }
    val name = session.title.ifEmpty { "session ${session.id.takeLast(8)}" }
    val link = if (opensAsThread) SenderLink.Thread(session.id) else SenderLink.None
    return SenderReading(name, name, OfficeFace(session.id, Pose.Idle, isAssistant = false), link)
}
