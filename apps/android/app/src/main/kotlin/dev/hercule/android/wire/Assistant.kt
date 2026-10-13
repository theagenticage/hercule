package dev.hercule.android.wire

import kotlin.time.Instant
import kotlinx.serialization.Serializable

/**
 * An assistant, as `assistant.query` and `assistant.read` return it, cut to what the app
 * reads. Its system prompt, heartbeat, rotation and tool settings are left out.
 */
@Serializable
data class Assistant(
    val id: String,
    val name: String,
    val instanceId: String,
    val permissionProfileId: String,
    val accessMode: AccessMode,
    /** Null means the provider instance's default model. */
    val model: ModelSelection?,
    val createdAt: Instant,
    val updatedAt: Instant,
    val reply: AssistantReply,
    /** The conversation every app shows when the user opens this assistant. */
    val mainConversationId: String,
)

/**
 * Which of an assistant's words reach its conversation: one message per turn
 * ([TurnEnd]) or one per text segment ([Segments]).
 */
@Serializable
@JvmInline
value class AssistantReply(val wire: String) {
    companion object {
        val TurnEnd = AssistantReply("turn-end")
        val Segments = AssistantReply("segments")
    }
}
