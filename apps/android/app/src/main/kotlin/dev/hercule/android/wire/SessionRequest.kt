package dev.hercule.android.wire

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonTransformingSerializer
import kotlinx.serialization.json.jsonObject

/**
 * A Request one agent of a session waits on: an approval or a question. The wire tells the
 * five kinds apart by `kind`, and each kind is its own class here, so a `when` over the
 * subtypes is exhaustive. A kind this build does not know decodes to [UnknownRequest], which
 * the app can show but not answer.
 *
 * `subagentId` and `subagentName` are set when a subagent asked. They are only on the
 * requests a [Session] lists; inside a `request.opened` event they are always null, because
 * that event carries the subagent on the event itself.
 */
@Serializable(with = SessionRequestSerializer::class)
sealed interface SessionRequest {
    val requestId: String
    val itemId: String
    val subagentId: String?
    val subagentName: String?
}

/** A Request answered with one of its [decisions] through `session.respondToApprovalRequest`. */
sealed interface ApprovalRequest : SessionRequest {
    /** The decisions this request accepts, never empty. Offer only these. */
    val decisions: List<ApprovalDecision>
}

/** The agent asks to run a shell command. */
@Serializable
data class CommandApproval(
    override val requestId: String,
    override val itemId: String,
    val detail: Detail,
    override val decisions: List<ApprovalDecision>,
    override val subagentId: String? = null,
    override val subagentName: String? = null,
) : ApprovalRequest {
    @Serializable
    data class Detail(val command: String)
}

/** The agent asks to change one or more files. */
@Serializable
data class FileChangeApproval(
    override val requestId: String,
    override val itemId: String,
    val detail: Detail,
    override val decisions: List<ApprovalDecision>,
    override val subagentId: String? = null,
    override val subagentName: String? = null,
) : ApprovalRequest {
    @Serializable
    data class Detail(val paths: List<String>)
}

/** The agent asks to read one or more files. */
@Serializable
data class FileReadApproval(
    override val requestId: String,
    override val itemId: String,
    val detail: Detail,
    override val decisions: List<ApprovalDecision>,
    override val subagentId: String? = null,
    override val subagentName: String? = null,
) : ApprovalRequest {
    @Serializable
    data class Detail(val paths: List<String>)
}

/** The agent asks to call a tool. */
@Serializable
data class ToolApproval(
    override val requestId: String,
    override val itemId: String,
    val detail: Detail,
    override val decisions: List<ApprovalDecision>,
    override val subagentId: String? = null,
    override val subagentName: String? = null,
) : ApprovalRequest {
    @Serializable
    data class Detail(val toolName: String)
}

/**
 * The agent asks one to four questions, answered through `session.respondToQuestion`. A
 * question has no decline: to turn it down, the user interrupts the asking agent's turn.
 *
 * [async] is true when the asking agent does not wait for the answer: it keeps working, and
 * the request stays open after its turn ends, until it is answered, the agent is stopped, or
 * the session exits. Absent when the agent waits.
 */
@Serializable
data class QuestionRequest(
    override val requestId: String,
    override val itemId: String,
    val detail: Detail,
    override val subagentId: String? = null,
    override val subagentName: String? = null,
    val async: Boolean? = null,
) : SessionRequest {
    @Serializable
    data class Detail(val questions: List<Question>)
}

/** A request whose `kind` this build does not know. [json] holds the whole request. */
@Serializable(with = UnknownRequestSerializer::class)
data class UnknownRequest(val json: JsonObject) : SessionRequest {
    val kind: String? get() = json.readString("kind")
    override val requestId: String get() = json.readString("requestId").orEmpty()
    override val itemId: String get() = json.readString("itemId").orEmpty()
    override val subagentId: String? get() = json.readString("subagentId")
    override val subagentName: String? get() = json.readString("subagentName")
}

/**
 * One question of a [QuestionRequest]. [header] is a short label, and also the key its
 * answer goes under in [QuestionAnswers]. An empty [options] list means the answer is free
 * text only; the user may type custom text even when there are options.
 */
@Serializable
data class Question(
    val question: String,
    val header: String,
    val options: List<QuestionOption>,
    val multiSelect: Boolean,
    /**
     * True when the harness asked to keep the answer secret. Nothing can: the answer is shown,
     * stored and sent like any other, so the app warns the user instead. Absent otherwise.
     */
    val secret: Boolean? = null,
)

/**
 * One option a [Question] offers. Its [label] is the answer text sent when it is picked.
 * [description] is null when the agent wrote none.
 */
@Serializable
data class QuestionOption(
    val label: String,
    val description: String? = null,
)

/** The decision an approval is answered with. Unknown values decode outside the constants. */
@Serializable
@JvmInline
value class ApprovalDecision(val wire: String) {
    companion object {
        val Allow = ApprovalDecision("allow")
        val AllowAlways = ApprovalDecision("allow_always")
        val Deny = ApprovalDecision("deny")
        val Cancel = ApprovalDecision("cancel")
    }
}

/**
 * The answers to a [QuestionRequest], keyed by each question's `header`. Each value holds the
 * picked option labels or the text the user typed, at least one non-blank entry.
 *
 * On the wire a value is a single string or an array of strings. A one-entry list is sent as
 * a single string and a longer one as an array; the controller accepts both forms for every
 * question. Both forms decode to a list.
 */
typealias QuestionAnswers = Map<String, @Serializable(with = QuestionAnswerSerializer::class) List<String>>

/** Converts one answer between the wire's "string or array of strings" and a list. */
object QuestionAnswerSerializer :
    JsonTransformingSerializer<List<String>>(ListSerializer(String.serializer())) {
    override fun transformDeserialize(element: JsonElement): JsonElement =
        if (element is JsonPrimitive) JsonArray(listOf(element)) else element

    override fun transformSerialize(element: JsonElement): JsonElement =
        if (element is JsonArray && element.size == 1) element.single() else element
}

/** Picks the [SessionRequest] subtype from the request's `kind`. */
object SessionRequestSerializer :
    JsonContentPolymorphicSerializer<SessionRequest>(SessionRequest::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<SessionRequest> =
        when (element.jsonObject.readString("kind")) {
            "command_approval" -> CommandApproval.serializer()
            "file_change_approval" -> FileChangeApproval.serializer()
            "file_read_approval" -> FileReadApproval.serializer()
            "tool_approval" -> ToolApproval.serializer()
            "question" -> QuestionRequest.serializer()
            else -> UnknownRequestSerializer
        }
}

/** Reads and writes an [UnknownRequest] as the JSON object it holds. */
object UnknownRequestSerializer : KSerializer<UnknownRequest> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): UnknownRequest =
        UnknownRequest((decoder as JsonDecoder).decodeJsonElement().jsonObject)

    override fun serialize(encoder: Encoder, value: UnknownRequest) =
        (encoder as JsonEncoder).encodeJsonElement(value.json)
}

/** Returns the string at [key], or null when the key is missing or holds something else. */
internal fun JsonObject.readString(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
