package dev.hercule.android.alerts

import dev.hercule.android.wire.AccessMode
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.AssistantReply
import dev.hercule.android.wire.CommandApproval
import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.ConversationSenderRole
import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.ModelSelection
import dev.hercule.android.wire.HarnessEvent
import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionOption
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.SessionStatus
import dev.hercule.android.wire.TranscriptRow
import kotlin.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Builders for the records the alert tests decide from, with only the fields the rules read as parameters. */

val AT: Instant = Instant.parse("2026-10-12T08:14:55Z")

fun buildSession(
    id: String,
    title: String = "Fix 3-D Secure checkout",
    status: SessionStatus = SessionStatus.Busy,
    openRequests: List<SessionRequest> = emptyList(),
    runId: String? = null,
): Session = Session(
    id = id,
    title = title,
    status = status,
    resumable = false,
    resumeHeld = false,
    permissionProfileId = "profile-1",
    agentId = null,
    conversationId = null,
    runId = runId,
    stepId = null,
    instanceId = "instance-1",
    runnerId = "runner-1",
    workspaceId = null,
    projectId = null,
    requestedAccessMode = AccessMode.ApprovalRequired,
    accessMode = AccessMode.ApprovalRequired,
    nativeSessionId = null,
    modelSelection = ModelSelection("claude-opus-4-5", emptyMap()),
    parentSessionId = null,
    openRequests = openRequests,
    openPermissionRequests = emptyList(),
    toolCalls = 0,
    createdAt = AT,
    startedAt = AT,
    exitedAt = null,
    lastActivityAt = AT,
)

fun buildCommand(
    requestId: String,
    command: String = "pnpm test cart",
    decisions: List<ApprovalDecision> = listOf(ApprovalDecision.Allow, ApprovalDecision.Deny),
    subagentId: String? = null,
    subagentName: String? = null,
) = CommandApproval(requestId, "item-$requestId", CommandApproval.Detail(command), decisions, subagentId, subagentName)

fun buildQuestion(
    requestId: String,
    vararg questions: Question = arrayOf(buildAsked()),
) = QuestionRequest(requestId, "item-$requestId", QuestionRequest.Detail(questions.toList()))

fun buildAsked(
    question: String = "Which region should the rollout start in?",
    header: String = "Region",
    options: List<String> = listOf("eu-west", "us-east"),
    multiSelect: Boolean = false,
    secret: Boolean? = null,
) = Question(question, header, options.map { QuestionOption(it, "") }, multiSelect, secret)

fun buildAssistant(id: String = "assistant-1", name: String = "Poirot") = Assistant(
    id = id,
    name = name,
    instanceId = "instance-1",
    permissionProfileId = "profile-1",
    accessMode = AccessMode.ApprovalRequired,
    model = null,
    createdAt = AT,
    updatedAt = AT,
    reply = AssistantReply.TurnEnd,
    mainConversationId = "conversation-$id",
)

fun buildMessage(position: Long, text: String, role: ConversationSenderRole = ConversationSenderRole.Assistant) =
    ConversationMessage(
        id = "message-$position",
        conversationId = "conversation-1",
        containerKey = null,
        position = position,
        senderRole = role,
        senderLabel = "",
        text = text,
        sessionId = null,
        turnId = null,
        itemId = null,
        actor = "user",
        createdAt = AT,
    )

/** Builds transcript rows, numbering their positions in order. */
fun buildTranscript(vararg events: HarnessEvent): List<TranscriptRow> =
    events.mapIndexed { index, event -> TranscriptRow(index.toLong(), AT.toString(), event) }

fun turnStarted(subagentId: String? = null) = HarnessEvent.TurnStarted(subagentId = subagentId, turnId = "turn-1")

fun itemStarted(id: String, kind: ItemKind, detail: Map<String, String> = emptyMap(), subagentId: String? = null) =
    HarnessEvent.ItemStarted(subagentId, "turn-1", id, kind, buildDetail(detail))

fun itemCompleted(id: String, kind: ItemKind, detail: Map<String, String> = emptyMap(), subagentId: String? = null) =
    HarnessEvent.ItemCompleted(subagentId, "turn-1", id, kind, buildDetail(detail), ItemStatus.Completed)

private fun buildDetail(detail: Map<String, String>) = JsonObject(detail.mapValues { JsonPrimitive(it.value) })
