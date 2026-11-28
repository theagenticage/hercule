package dev.hercule.android.wire

import kotlin.time.Instant
import kotlinx.serialization.Serializable

/**
 * A conversation with an assistant in one platform container, as `conversation.query` and
 * `conversation.read` return it. On the web channel [containerKey] is always null.
 */
@Serializable
data class Conversation(
    val id: String,
    val assistantId: String,
    val channel: ConversationChannel,
    val containerKey: String?,
    val createdAt: Instant,
)

/** The platform a conversation lives on. Only `web` exists today; more will be added. */
@Serializable
@JvmInline
value class ConversationChannel(val wire: String) {
    companion object {
        val Web = ConversationChannel("web")
    }
}

/**
 * One message of a conversation, as `conversation.queryMessages` lists it and
 * `conversation.send` returns it. [position] starts at 1 and goes up by exactly 1 per
 * message, so it identifies a message within its conversation and orders it.
 */
@Serializable
data class ConversationMessage(
    val id: String,
    val conversationId: String,
    val containerKey: String?,
    val position: Long,
    val senderRole: ConversationSenderRole,
    /** The username for an owner message, the assistant's name for a reply or a notice. */
    val senderLabel: String,
    val text: String,
    /** The session that wrote a reply or a notice; null on owner messages. */
    val sessionId: String?,
    /** The harness's turn id; set only on replies. */
    val turnId: String?,
    /** The harness's item id; set only on replies. */
    val itemId: String?,
    /** Who wrote it: `user`, `session:<id>` or `system`. */
    val actor: String,
    val createdAt: Instant,
)

/**
 * Who a [ConversationMessage] is from. A [Notice] is a message the system writes, such as
 * "Ada can't be reached: no runner is connected".
 */
@Serializable
@JvmInline
value class ConversationSenderRole(val wire: String) {
    companion object {
        val Owner = ConversationSenderRole("owner")
        val Assistant = ConversationSenderRole("assistant")
        val Notice = ConversationSenderRole("notice")
    }
}

/**
 * The body of `conversation.send` (`POST /api/v1/conversations/{id}/messages`). The response
 * is the stored owner [ConversationMessage]; the reply arrives later, announced on the
 * `conversation` live topic.
 */
@Serializable
data class ConversationSendInput(val text: String)
