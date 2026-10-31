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
    val event: HarnessEvent,
)

/**
 * One event a harness reported, picked by the wire's `_tag`. A tag this build does not know
 * decodes to [Unknown] instead of failing the whole page.
 *
 * The envelope every event carries (`eventId`, `sessionId`, `at`, `harnessRefs`, `raw`) is
 * not modelled: the enclosing [TranscriptRow] already gives the position and time, and the
 * session is known from the request. `subagentId`, where present, names the subagent the
 * event belongs to; null means the session's own agent.
 */
@Serializable(with = HarnessEventSerializer::class)
sealed interface HarnessEvent {
    /** The session's process started. */
    @Serializable
    data object SessionStarted : HarnessEvent

    /** The session's process ended. [message] explains the exit when the reason alone does not. */
    @Serializable
    data class SessionExited(
        val reason: ExitReason,
        val message: String? = null,
    ) : HarnessEvent

    /** A subagent was introduced, before any event of its own. */
    @Serializable
    data class SubagentStarted(
        val subagentId: String,
        val parentSubagentId: String? = null,
        /** The `subagent` item that started it, in its parent's transcript. */
        val itemId: String? = null,
        val description: String? = null,
        val agentType: String? = null,
    ) : HarnessEvent

    @Serializable
    data class TurnStarted(
        val subagentId: String? = null,
        val turnId: String,
        val model: String? = null,
    ) : HarnessEvent

    @Serializable
    data class TurnCompleted(
        val subagentId: String? = null,
        val turnId: String,
        val state: TurnState,
        val usage: Usage? = null,
        val costUsd: Double? = null,
        val error: String? = null,
    ) : HarnessEvent

    /**
     * An item began. [detail] is any JSON value, usually an object whose keys differ per
     * harness and per [kind], so check its shape and read every key as optional. The text of a message or of reasoning is never in it; it
     * arrives as [ContentDelta]s with the same [itemId].
     */
    @Serializable
    data class ItemStarted(
        val subagentId: String? = null,
        val turnId: String,
        val itemId: String,
        val kind: ItemKind,
        val detail: JsonElement? = null,
    ) : HarnessEvent

    /** An item ended. [detail] follows the same rules as on [ItemStarted]. */
    @Serializable
    data class ItemCompleted(
        val subagentId: String? = null,
        val turnId: String,
        val itemId: String,
        val kind: ItemKind,
        val detail: JsonElement? = null,
        val status: ItemStatus,
    ) : HarnessEvent

    /** Text appended to one item's stream. Append deltas in order, keyed by [itemId]. */
    @Serializable
    data class ContentDelta(
        val subagentId: String? = null,
        val turnId: String,
        val itemId: String,
        val streamKind: StreamKind,
        val delta: String,
    ) : HarnessEvent

    /**
     * A token snapshot. [usage] is null when the harness could only report an incomplete
     * count, which the wire sends as `usageReport` and this record leaves out.
     */
    @Serializable
    data class SessionUsageUpdated(
        val subagentId: String? = null,
        val usage: Usage? = null,
    ) : HarnessEvent

    @Serializable
    data class RuntimeWarning(
        val subagentId: String? = null,
        val turnId: String? = null,
        val message: String,
    ) : HarnessEvent

    /** Neutral information about the session, such as "Conversation was cleared". Nothing went wrong. */
    @Serializable
    data class RuntimeNotice(
        val subagentId: String? = null,
        val turnId: String? = null,
        val message: String,
    ) : HarnessEvent

    /** [errorClass] is an open vocabulary, such as `rate_limit`; show it as it is. */
    @Serializable
    data class RuntimeError(
        val subagentId: String? = null,
        val turnId: String? = null,
        @SerialName("class") val errorClass: String,
        val message: String? = null,
    ) : HarnessEvent

    /**
     * An agent asked [request]. It waits for the answer, except for an async question, which the
     * agent keeps working past.
     */
    @Serializable
    data class RequestOpened(
        val subagentId: String? = null,
        val request: SessionRequest,
    ) : HarnessEvent

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
    ) : HarnessEvent

    /**
     * An event this build has no class for. [json] holds the whole event. It arrives in one of two
     * shapes:
     *
     * - the controller's own `unknown` event, which keeps the tag the event arrived with in
     *   `originalType` and the event itself in `payload`;
     * - a raw event with a `_tag` this build does not know, from a controller newer than the app.
     */
    @Serializable(with = UnknownHarnessEventSerializer::class)
    data class Unknown(val json: JsonObject) : HarnessEvent {
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

/** Picks the [HarnessEvent] subtype from the event's `_tag`. */
object HarnessEventSerializer :
    JsonContentPolymorphicSerializer<HarnessEvent>(HarnessEvent::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<HarnessEvent> =
        when (element.jsonObject.readString("_tag")) {
            "session.started" -> HarnessEvent.SessionStarted.serializer()
            "session.exited" -> HarnessEvent.SessionExited.serializer()
            "subagent.started" -> HarnessEvent.SubagentStarted.serializer()
            "turn.started" -> HarnessEvent.TurnStarted.serializer()
            "turn.completed" -> HarnessEvent.TurnCompleted.serializer()
            "item.started" -> HarnessEvent.ItemStarted.serializer()
            "item.completed" -> HarnessEvent.ItemCompleted.serializer()
            "content.delta" -> HarnessEvent.ContentDelta.serializer()
            "session.usage.updated" -> HarnessEvent.SessionUsageUpdated.serializer()
            "runtime.warning" -> HarnessEvent.RuntimeWarning.serializer()
            "runtime.notice" -> HarnessEvent.RuntimeNotice.serializer()
            "runtime.error" -> HarnessEvent.RuntimeError.serializer()
            "request.opened" -> HarnessEvent.RequestOpened.serializer()
            "request.resolved" -> HarnessEvent.RequestResolved.serializer()
            else -> UnknownHarnessEventSerializer
        }
}

/** Reads and writes a [HarnessEvent.Unknown] as the JSON object it holds. */
object UnknownHarnessEventSerializer : KSerializer<HarnessEvent.Unknown> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): HarnessEvent.Unknown =
        HarnessEvent.Unknown((decoder as JsonDecoder).decodeJsonElement().jsonObject)

    override fun serialize(encoder: Encoder, value: HarnessEvent.Unknown) =
        (encoder as JsonEncoder).encodeJsonElement(value.json)
}
