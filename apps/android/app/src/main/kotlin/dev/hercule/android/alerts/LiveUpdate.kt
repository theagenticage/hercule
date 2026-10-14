package dev.hercule.android.alerts

import dev.hercule.android.office.buildRequestSummary
import dev.hercule.android.office.readFileName
import dev.hercule.android.wire.CommandApproval
import dev.hercule.android.wire.FileChangeApproval
import dev.hercule.android.wire.FileReadApproval
import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ProviderEvent
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.ToolApproval
import dev.hercule.android.wire.TranscriptRow
import dev.hercule.android.wire.UnknownRequest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A thread's Live Update, its one notification: the book's Live Activity in Android's form.
 * Every thread waiting on the user shows one, and so does the followed thread while it
 * works. The track is [doneSteps] segments in the thread's hue, then one last segment:
 * unfilled in the thread's hue while it works, or in the "you" colour while it waits on the
 * user. The thread's face sits where the done segments end.
 */
data class LiveUpdate(
    val sessionId: String,
    val title: String,
    /**
     * "Waiting on you · <question>" while waiting, with a second line "+N more waiting" when
     * other Requests wait too; the latest step while working.
     */
    val text: String,
    /** The Now Bar pill's text, such as "Working" or "Run?". */
    val shortText: String,
    /** The steps done in the current turn, at most [MAX_DONE_STEPS]. */
    val doneSteps: Int,
    val isWaiting: Boolean,
    /** The newest open Request's id while waiting, the Request the buttons answer; null while working. */
    val requestId: String?,
    /** The buttons while waiting, the same as an assistant's Request alert's; null while working. */
    val actions: AlertActions?,
    /** True when this post should alert, because a Request has just opened. */
    val alert: Boolean,
)

/** The Live Update shows at most this many done segments, the latest ones. */
const val MAX_DONE_STEPS = 3

/**
 * Builds the Live Update for [session] from [transcript], the session's transcript rows in
 * position order. Only the session's own agent counts: a subagent's turns and items are left
 * out, so a subagent starting its own turn does not reset the track.
 */
fun buildLiveUpdate(session: Session, transcript: List<TranscriptRow>, alert: Boolean): LiveUpdate {
    val steps = readCurrentTurnSteps(transcript)
    val doneSteps = steps.count { it.isDone }
    val newest = session.openRequests.lastOrNull()
    return LiveUpdate(
        sessionId = session.id,
        title = session.title,
        text = if (newest != null) {
            "Waiting on you · ${buildRequestSummary(session.openRequests)}"
        } else {
            steps.lastOrNull()?.let { describeStep(it.kind, it.detail) } ?: WORKING
        },
        shortText = newest?.let(::formatShortText) ?: WORKING,
        doneSteps = doneSteps.coerceAtMost(MAX_DONE_STEPS),
        isWaiting = newest != null,
        requestId = newest?.requestId,
        actions = newest?.let { decideAlertActions(session.id, it) },
        alert = alert,
    )
}

/** Returns the Now Bar text for a thread waiting on [request], such as "Run?" or "Answer?". */
fun formatShortText(request: SessionRequest): String = when (request) {
    is CommandApproval, is ToolApproval -> "Run?"
    is FileChangeApproval -> "Edit?"
    is FileReadApproval -> "Read?"
    is QuestionRequest -> "Answer?"
    is UnknownRequest -> "Waiting"
}

/**
 * Returns a short description of one step, such as "pnpm test cart" or "Edit checkout.ts".
 * Item details differ per provider and may be any JSON value, so every key is optional; a
 * step whose detail is not an object, or names nothing useful, reads "Working".
 */
fun describeStep(kind: ItemKind, detail: JsonElement?): String {
    val fields = detail as? JsonObject
    val input = fields?.get("input") as? JsonObject
    fun read(key: String): String? =
        (fields?.get(key) as? JsonPrimitive ?: input?.get(key) as? JsonPrimitive)
            ?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
    val path = read("path") ?: read("file_path")
    return when (kind) {
        ItemKind.CommandExecution -> read("command")?.lineSequence()?.map { it.trim() }?.firstOrNull { it.isNotEmpty() }
        ItemKind.FileChange -> path?.let { "Edit ${readFileName(it)}" }
        ItemKind.FileRead -> path?.let { "Read ${readFileName(it)}" }
        ItemKind.FileSearch -> read("pattern")?.let { "Search $it" }
        ItemKind.WebSearch -> "Search the web"
        ItemKind.ToolCall -> read("name")
        ItemKind.Subagent -> read("description")
        else -> null
    } ?: WORKING
}

/** One item event of the own agent's current turn that counts as a step. */
private data class Step(val kind: ItemKind, val detail: JsonElement?, val isDone: Boolean)

/**
 * Returns the steps of the own agent's current turn: its item events after its latest
 * `turn.started`, except the agent's messages and its reasoning. Returns none when the
 * transcript holds no `turn.started`.
 */
private fun readCurrentTurnSteps(transcript: List<TranscriptRow>): List<Step> {
    val events = transcript.map { it.event }
    val start = events.indexOfLast { it is ProviderEvent.TurnStarted && it.subagentId == null }
    if (start < 0) return emptyList()
    return events.drop(start + 1).mapNotNull { event ->
        when (event) {
            is ProviderEvent.ItemStarted -> event.takeIf { it.subagentId == null }?.let { Step(it.kind, it.detail, isDone = false) }
            is ProviderEvent.ItemCompleted -> event.takeIf { it.subagentId == null }?.let { Step(it.kind, it.detail, isDone = true) }
            else -> null
        }
    }.filter { it.kind != ItemKind.AssistantMessage && it.kind != ItemKind.Reasoning }
}

private const val WORKING = "Working"
