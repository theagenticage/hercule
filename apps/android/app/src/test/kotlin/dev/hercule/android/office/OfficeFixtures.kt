package dev.hercule.android.office

import dev.hercule.android.wire.AccessMode
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.AssistantReply
import dev.hercule.android.wire.CommandApproval
import dev.hercule.android.wire.ModelSelection
import dev.hercule.android.wire.Project
import dev.hercule.android.wire.Runner
import dev.hercule.android.wire.RunnerConnectivity
import dev.hercule.android.wire.RunnerLifecycle
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.SessionStatus
import kotlin.time.Instant

/**
 * Records for the office tests, with the defaults of `buildSession`, `buildRunner` and
 * `buildProject` in packages/client-core/src/threads/workspaces.testing.ts, so a case copied
 * from a client-core test sets the same fields.
 */
internal val AT: Instant = Instant.parse("2026-09-10T09:00:00.000Z")

internal const val MOSS_ID = "r-moss"

/** Returns a session with client-core's test defaults: an idle thread on moss, last active at [AT]. */
internal fun buildSession(
    id: String,
    title: String = "A thread",
    status: SessionStatus = SessionStatus.Idle,
    resumable: Boolean = false,
    resumeHeld: Boolean = false,
    agentId: String? = null,
    conversationId: String? = null,
    runId: String? = null,
    runnerId: String = MOSS_ID,
    projectId: String? = null,
    openRequests: List<SessionRequest> = emptyList(),
    lastActivityAt: Instant = AT,
): Session = Session(
    id = id,
    title = title,
    status = status,
    resumable = resumable,
    resumeHeld = resumeHeld,
    permissionProfileId = "p-unrestricted",
    agentId = agentId,
    conversationId = conversationId,
    runId = runId,
    stepId = null,
    runnerId = runnerId,
    workspaceId = null,
    projectId = projectId,
    requestedAccessMode = AccessMode.ApprovalRequired,
    accessMode = AccessMode.ApprovalRequired,
    nativeSessionId = null,
    modelSelection = ModelSelection("claude-sonnet-5", emptyMap()),
    parentSessionId = null,
    openRequests = openRequests,
    openPermissionRequests = emptyList(),
    toolCalls = 0,
    createdAt = AT,
    startedAt = AT,
    exitedAt = null,
    lastActivityAt = lastActivityAt,
)

/** Returns an online, active runner that holds four sessions at once. */
internal fun buildRunner(
    id: String,
    name: String,
    connectivity: RunnerConnectivity = RunnerConnectivity.Online,
    lifecycle: RunnerLifecycle = RunnerLifecycle.Active,
    maxConcurrentSessions: Int = 4,
): Runner = Runner(
    id = id,
    name = name,
    connectivity = connectivity,
    lifecycle = lifecycle,
    reserved = false,
    version = "0.4.2",
    labels = emptyList(),
    maxConcurrentSessions = maxConcurrentSessions,
    lastSeenAt = AT,
)

internal fun buildProject(id: String, name: String): Project =
    Project(id = id, name = name, createdAt = AT, updatedAt = AT)

internal fun buildAssistant(id: String, name: String): Assistant = Assistant(
    id = id,
    name = name,
    permissionProfileId = "p-unrestricted",
    accessMode = AccessMode.ApprovalRequired,
    model = null,
    createdAt = AT,
    updatedAt = AT,
    reply = AssistantReply.TurnEnd,
    mainConversationId = "c-$id",
)

/** Returns a command approval that offers allow and deny. */
internal fun buildCommandRequest(
    requestId: String,
    command: String,
    subagentId: String? = null,
    subagentName: String? = null,
): CommandApproval = CommandApproval(
    requestId = requestId,
    itemId = "tool-1",
    detail = CommandApproval.Detail(command),
    decisions = listOf(ApprovalDecision.Allow, ApprovalDecision.Deny),
    subagentId = subagentId,
    subagentName = subagentName,
)
