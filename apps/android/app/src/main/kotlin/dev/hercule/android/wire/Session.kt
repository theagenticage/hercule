package dev.hercule.android.wire

import kotlin.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

/**
 * A session, as `session.read` and `session.query` return it. A session with no [agentId] is
 * a Thread; one with a [conversationId] answers an assistant's conversation.
 */
@Serializable
data class Session(
    val id: String,
    val title: String,
    val status: SessionStatus,
    /** True when the next input resumes this exited session in place, under the same id. */
    val resumable: Boolean,
    /** True when the crash-loop guard holds back the automatic resume. */
    val resumeHeld: Boolean,
    val permissionProfileId: String,
    val agentId: String?,
    val conversationId: String?,
    val runId: String?,
    val stepId: String?,
    val instanceId: String,
    val runnerId: String,
    val workspaceId: String?,
    val projectId: String?,
    val requestedAccessMode: AccessMode,
    /** The mode the session really runs in, which can differ from [requestedAccessMode]. */
    val accessMode: AccessMode,
    val nativeSessionId: String?,
    val modelSelection: ModelSelection,
    val parentSessionId: String?,
    /** The Requests the session's agents wait on, oldest first. Empty when none waits. */
    val openRequests: List<SessionRequest>,
    /** The Permission Requests waiting for the user's decision, oldest first. */
    val openPermissionRequests: List<PermissionRequest>,
    /** Absent until the harness reports exact usage. */
    val usage: Usage? = null,
    val toolCalls: Int,
    val createdAt: Instant,
    val startedAt: Instant?,
    val exitedAt: Instant?,
    val lastActivityAt: Instant,
)

/**
 * The status of a [Session]. A status this build does not know decodes to a value outside the
 * constants below. An exited session with `resumable` true is resumed by its next input.
 */
@Serializable
@JvmInline
value class SessionStatus(val wire: String) {
    companion object {
        val Queued = SessionStatus("queued")
        val Starting = SessionStatus("starting")
        val Idle = SessionStatus("idle")
        val Busy = SessionStatus("busy")
        val Exited = SessionStatus("exited")
    }
}

/** How much an agent may do without asking. Unknown modes decode to a value outside the constants. */
@Serializable
@JvmInline
value class AccessMode(val wire: String) {
    companion object {
        val ApprovalRequired = AccessMode("approval-required")
        val AutoAcceptEdits = AccessMode("auto-accept-edits")
        val Auto = AccessMode("auto")
        val FullAccess = AccessMode("full-access")
    }
}

/**
 * The model a session or an assistant runs under. Each option value is a JSON string or a
 * JSON boolean.
 */
@Serializable
data class ModelSelection(
    val model: String,
    val options: Map<String, JsonPrimitive>,
)

/** Token counts. The three optional fields are reported by only some harnesses. */
@Serializable
data class Usage(
    val inputTokens: Long,
    val outputTokens: Long,
    val cacheReadTokens: Long? = null,
    val cacheWriteTokens: Long? = null,
    val costUsd: Double? = null,
)

/**
 * An agent's ask for a grant its permission profile lacks. The user decides it with
 * `permission.decide`. `operation`, the call the agent wanted to make, is not modelled here.
 */
@Serializable
data class PermissionRequest(
    val id: String,
    val grant: String,
    val reason: String,
    val createdAt: Instant,
)

/** The body of `session.input` (`POST /api/v1/sessions/{id}/input`). */
@Serializable
data class SessionInputPayload(
    /** May be empty only when [attachments] holds at least one image id. */
    val text: String,
    val attachments: List<String>? = null,
    /** Switches the session to this model from this input on. */
    val model: String? = null,
    val options: Map<String, JsonPrimitive>? = null,
    /** True folds the input into a busy session's running turn. Left out, the input queues. */
    val steer: Boolean? = null,
)

/** What `session.input` returns: the stored input's id and what happened to it. */
@Serializable
data class SessionInputOutcome(
    val inputId: String,
    val result: SessionInputResult,
)

/** What happened to an input: it opened a turn, steered the running turn, or queued. */
@Serializable
@JvmInline
value class SessionInputResult(val wire: String) {
    companion object {
        val Opened = SessionInputResult("opened")
        val Steered = SessionInputResult("steered")
        val Queued = SessionInputResult("queued")
    }
}

/**
 * The body of `session.respondToApprovalRequest`
 * (`POST /api/v1/sessions/{id}/respond-to-approval-request`). [decision] must be one of the
 * request's own `decisions`. The response is the updated [Session].
 */
@Serializable
data class SessionRespondToApprovalRequestInput(
    val requestId: String,
    val decision: ApprovalDecision,
)

/**
 * The body of `session.respondToQuestion` (`POST /api/v1/sessions/{id}/respond-to-question`).
 * The response is the updated [Session].
 */
@Serializable
data class SessionRespondToQuestionInput(
    val requestId: String,
    val answers: QuestionAnswers,
)
