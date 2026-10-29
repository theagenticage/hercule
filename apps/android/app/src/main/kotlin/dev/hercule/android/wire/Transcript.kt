package dev.hercule.android.wire

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * One row of an agent's transcript, as `transcript.read` returns it and a
 * `session:<id>:stream` topic pushes it. Order rows by [position], never by [at]: [at] is the
 * runner's own clock, sent as a plain ISO string that is neither checked nor monotonic across
 * machines.
 */
@Serializable
data class TranscriptRow(
    val position: Long,
    val at: String,
    val event: ProviderEvent,
)

/**
 * One event a harness reported, picked by the wire's `_tag`. A tag this build does not know
 * decodes to [Unknown] instead of failing the whole page.
 *
 * The envelope every event carries (`eventId`, `sessionId`, `at`, `providerRefs`, `raw`) is
 * not modelled: the enclosing [TranscriptRow] already gives the position and time, and the
 * session is known from the request. `subagentId`, where present, names the subagent the
 * event belongs to; null means the session's own agent.
 */
@Serializable(with = ProviderEventSerializer::class)
sealed interface ProviderEvent {
    /** The session's process started. */
    @Serializable
    data object SessionStarted : ProviderEvent

    /** The session's process ended. [message] explains the exit when the reason alone does not. */
    @Serializable
    data class SessionExited(
        val reason: ExitReason,
        val message: String? = null,
    ) : ProviderEvent

    /** A subagent was introduced, before any event of its own. */
    @Serializable
    data class SubagentStarted(
        val subagentId: String,
        val parentSubagentId: String? = null,
        /** The `subagent` item that started it, in its parent's transcript. */
        val itemId: String? = null,
        val description: String? = null,
        val agentType: String? = null,
    ) : ProviderEvent

    @Serializable
    data class TurnStarted(
        val subagentId: String? = null,
        val turnId: String,
        val model: String? = null,
    ) : ProviderEvent

    @Serializable
    data class TurnCompleted(
        val subagentId: String? = null,
        val turnId: String,
        val state: TurnState,
        val usage: Usage? = null,
        val costUsd: Double? = null,
        val error: String? = null,
    ) : ProviderEvent

    /**
     * An item began. [detail] is any JSON value, usually an object whose keys differ per
     * provider and per [kind], so check its shape and read every key as optional. The text of a message or of reasoning is never in it; it
     * arrives as [ContentDelta]s with the same [itemId].
     */
    @Serializable
    data class ItemStarted(
        val subagentId: String? = null,
        val turnId: String,
        val itemId: String,
        val kind: ItemKind,
        val detail: JsonElement? = null,
    ) : ProviderEvent

    /** An item ended. [detail] follows the same rules as on [ItemStarted]. */
    @Serializable
    data class ItemCompleted(
        val subagentId: String? = null,
        val turnId: String,
        val itemId: String,
        val kind: ItemKind,
        val detail: JsonElement? = null,
        val status: ItemStatus,
    ) : ProviderEvent

    /** Text appended to one item's stream. Append deltas in order, keyed by [itemId]. */
    @Serializable
    data class ContentDelta(
        val subagentId: String? = null,
        val turnId: String,
        val itemId: String,
        val streamKind: StreamKind,
        val delta: String,
    ) : ProviderEvent

    /**
     * A token snapshot. [usage] is null when the harness could only report an incomplete
     * count, which the wire sends as `usageReport` and this record leaves out.
     */
    @Serializable
    data class SessionUsageUpdated(
        val subagentId: String? = null,
        val usage: Usage? = null,
    ) : ProviderEvent

    @Serializable
    data class RuntimeWarning(
        val subagentId: String? = null,
        val turnId: String? = null,
        val message: String,
    ) : ProviderEvent

    /** Neutral information about the session, such as "Conversation was cleared". Nothing went wrong. */
    @Serializable
    data class RuntimeNotice(
        val subagentId: String? = null,
        val turnId: String? = null,
        val message: String,
    ) : ProviderEvent

    /** [errorClass] is an open vocabulary, such as `rate_limit`; show it as it is. */
    @Serializable
    data class RuntimeError(
        val subagentId: String? = null,
        val turnId: String? = null,
        @SerialName("class") val errorClass: String,
        val message: String? = null,
    ) : ProviderEvent

    /**
     * An agent asked [request]. It waits for the answer, except for an async question, which the
     * agent keeps working past.
     */
    @Serializable
    data class RequestOpened(
        val subagentId: String? = null,
        val request: SessionRequest,
    ) : ProviderEvent

    /**
     * An agent stopped waiting on a request: with a [decision] for an approval, or with the
     * user's [answers] for a question. Exactly one of the two is set.
     */
    @Serializable
    data class RequestResolved(
        val subagentId: String? = null,
        val requestId: String,
        val decision: ApprovalDecision? = null,
        val answers: QuestionAnswers? = null,
    ) : ProviderEvent

    /**
     * An event this build has no class for. [json] holds the whole event. It arrives in one of two
     * shapes:
     *
     * - the controller's own `unknown` event, which keeps the tag the event arrived with in
     *   `originalType` and the event itself in `payload`;
     * - a raw event with a `_tag` this build does not know, from a controller newer than the app.
     */
    @Serializable(with = UnknownProviderEventSerializer::class)
    data class Unknown(val json: JsonObject) : ProviderEvent {
        /** The tag the event arrived with, or null when the JSON holds none. */
        val originalType: String?
            get() = if (json.readString("_tag") == UNKNOWN_EVENT_TAG) json.readString("originalType") else json.readString("_tag")

        /** The agent the event belongs to, or null for the session's own agent. */
        val subagentId: String? get() = json.readString("subagentId")
    }
}

/** The kind of an item. Unknown kinds decode outside the constants; show them as a generic row. */
@Serializable
@JvmInline
value class ItemKind(val wire: String) {
    companion object {
        val UserMessage = ItemKind("user_message")
        val AssistantMessage = ItemKind("assistant_message")
        val Reasoning = ItemKind("reasoning")
        val CommandExecution = ItemKind("command_execution")
        val FileChange = ItemKind("file_change")
        val FileRead = ItemKind("file_read")
        val FileSearch = ItemKind("file_search")
        val ToolCall = ItemKind("tool_call")
        val WebSearch = ItemKind("web_search")
        val Subagent = ItemKind("subagent")
        val Plan = ItemKind("plan")
        val ContextCompaction = ItemKind("context_compaction")
        val Error = ItemKind("error")

        /** The wire's own catch-all for an item the runner could not map. */
        val Unknown = ItemKind("unknown")
    }
}

/** How an item ended: a failed tool gives [Failed], a denied approval gives [Declined]. */
@Serializable
@JvmInline
value class ItemStatus(val wire: String) {
    companion object {
        val Completed = ItemStatus("completed")
        val Failed = ItemStatus("failed")
        val Declined = ItemStatus("declined")
    }
}

/** How a turn ended. */
@Serializable
@JvmInline
value class TurnState(val wire: String) {
    companion object {
        val Completed = TurnState("completed")
        val Failed = TurnState("failed")
        val Interrupted = TurnState("interrupted")
    }
}

/** Why a session's process ended. */
@Serializable
@JvmInline
value class ExitReason(val wire: String) {
    companion object {
        val Stopped = ExitReason("stopped")
        val ProcessExit = ExitReason("process_exit")
        val IdleUnload = ExitReason("idle_unload")
        val RunnerRestart = ExitReason("runner_restart")
        val Crash = ExitReason("crash")
        val InactivityTimeout = ExitReason("inactivity_timeout")
        val AbsoluteTimeout = ExitReason("absolute_timeout")
        val WorkspaceFailed = ExitReason("workspace_failed")
    }
}

/** Which text stream a delta belongs to. */
@Serializable
@JvmInline
value class StreamKind(val wire: String) {
    companion object {
        val AssistantText = StreamKind("assistant_text")
        val ReasoningText = StreamKind("reasoning_text")
        val CommandOutput = StreamKind("command_output")
    }
}

/** The `_tag` of the controller's own event for a tag it did not know. */
private const val UNKNOWN_EVENT_TAG = "unknown"

/** Picks the [ProviderEvent] subtype from the event's `_tag`. */
object ProviderEventSerializer :
    JsonContentPolymorphicSerializer<ProviderEvent>(ProviderEvent::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<ProviderEvent> =
        when (element.jsonObject.readString("_tag")) {
            "session.started" -> ProviderEvent.SessionStarted.serializer()
            "session.exited" -> ProviderEvent.SessionExited.serializer()
            "subagent.started" -> ProviderEvent.SubagentStarted.serializer()
            "turn.started" -> ProviderEvent.TurnStarted.serializer()
            "turn.completed" -> ProviderEvent.TurnCompleted.serializer()
            "item.started" -> ProviderEvent.ItemStarted.serializer()
            "item.completed" -> ProviderEvent.ItemCompleted.serializer()
            "content.delta" -> ProviderEvent.ContentDelta.serializer()
            "session.usage.updated" -> ProviderEvent.SessionUsageUpdated.serializer()
            "runtime.warning" -> ProviderEvent.RuntimeWarning.serializer()
            "runtime.notice" -> ProviderEvent.RuntimeNotice.serializer()
            "runtime.error" -> ProviderEvent.RuntimeError.serializer()
            "request.opened" -> ProviderEvent.RequestOpened.serializer()
            "request.resolved" -> ProviderEvent.RequestResolved.serializer()
            else -> UnknownProviderEventSerializer
        }
}

/** Reads and writes a [ProviderEvent.Unknown] as the JSON object it holds. */
object UnknownProviderEventSerializer : KSerializer<ProviderEvent.Unknown> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): ProviderEvent.Unknown =
        ProviderEvent.Unknown((decoder as JsonDecoder).decodeJsonElement().jsonObject)

    override fun serialize(encoder: Encoder, value: ProviderEvent.Unknown) =
        (encoder as JsonEncoder).encodeJsonElement(value.json)
}
