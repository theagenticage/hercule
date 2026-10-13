package dev.hercule.android.ui.thread

import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.ProviderEvent
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.StreamKind
import dev.hercule.android.wire.TranscriptRow
import dev.hercule.android.wire.TurnState
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.time.Duration
import kotlin.time.Instant

/**
 * One block of a thread's transcript, in reading order, as the Thread screen draws it. A reduced
 * port of `buildThreadBlocks` in packages/client-core/src/threads/blocks.ts: the session's own
 * agent only, with no subagents and no "Working for" status line.
 */
sealed interface ThreadBlock {
    /** A key that stays the same while the transcript grows, for the list. */
    val key: String
}

/** A message the user sent into the thread. */
data class UserBlock(override val key: String, val text: String, val at: Instant) : ThreadBlock

/**
 * The items of one turn between two messages. [startedAt] is the turn's start or the end of the
 * message before; [endedAt] is the start of the message after, the end of the turn, or the
 * moment a Request opened, and null while the stretch still runs.
 */
data class WorkBlock(
    override val key: String,
    val items: List<WorkItem>,
    val startedAt: Instant,
    val endedAt: Instant?,
) : ThreadBlock

/**
 * One item of a work stretch: its [kind], what it acted on ([target], code when [targetIsCode]),
 * the files it named ([paths]), and how it ended, or null while it runs.
 */
data class WorkItem(
    val itemId: String,
    val kind: ItemKind,
    val target: String,
    val targetIsCode: Boolean,
    val paths: List<String>,
    val status: ItemStatus?,
)

/** A message the agent wrote, with the [model] its turn ran on. */
data class AgentBlock(
    override val key: String,
    val text: String,
    val startedAt: Instant,
    val model: String?,
) : ThreadBlock

/** The note that the thread waits on the user's answer to the Request [requestId]. */
data class WaitingBlock(override val key: String, val requestId: String, val openedAt: Instant) : ThreadBlock

/** A warning the runner or the harness reported, such as a retried request. */
data class WarningBlock(override val key: String, val message: String, val at: Instant) : ThreadBlock

/** The end of a turn that was stopped ([TurnState.Interrupted]) or failed. */
data class EndingBlock(override val key: String, val state: TurnState, val duration: Duration) : ThreadBlock

/**
 * Builds the blocks of a thread's transcript from its [rows], in position order:
 *
 * - a [UserBlock] per user message and an [AgentBlock] per agent message with text, each where
 *   its `item.started` row sits; an agent message's text is gathered from its delta rows;
 * - a [WorkBlock] per stretch of items between two messages of a turn, once it holds an item
 *   other than reasoning;
 * - a [WaitingBlock] where a Request in [openRequests] opened;
 * - a [WarningBlock] per `runtime.warning` row;
 * - an [EndingBlock] after a turn that was stopped or failed.
 *
 * Rows of subagents are left out: the thread shows its own agent's work. [tails] holds, by item
 * id, the text of agent messages still streaming that no row holds yet; it is added to the end
 * of the message's text.
 */
fun buildThreadBlocks(
    rows: List<TranscriptRow>,
    openRequests: List<SessionRequest>,
    tails: Map<String, String> = emptyMap(),
): List<ThreadBlock> {
    val ordered = rows.sortedBy { it.position }
    val openIds = openRequests.map { it.requestId }.toSet()
    val texts = HashMap<String, StringBuilder>()
    val statuses = HashMap<String, ItemStatus>()
    ordered.forEach { row ->
        when (val event = row.event) {
            is ProviderEvent.ContentDelta ->
                if (event.subagentId == null && event.streamKind == StreamKind.AssistantText) {
                    texts.getOrPut(event.itemId) { StringBuilder() }.append(event.delta)
                }
            is ProviderEvent.ItemCompleted -> if (event.subagentId == null) statuses[event.itemId] = event.status
            else -> Unit
        }
    }

    val blocks = mutableListOf<ThreadBlock>()
    var turnStart: Instant? = null
    var turnModel: String? = null
    // Where the next work stretch starts: the turn's start, or the end of the last agent message.
    var boundary: Instant? = null
    var stretch: BuildingStretch? = null

    fun closeStretch(at: Instant) {
        stretch?.let { building ->
            if (building.items.any { it.kind != ItemKind.Reasoning }) {
                blocks += WorkBlock(building.key, building.items.filter { it.kind != ItemKind.Reasoning }, building.startedAt, at)
            }
        }
        stretch = null
    }

    ordered.forEach { row ->
        val at = Instant.parse(row.at)
        when (val event = row.event) {
            is ProviderEvent.TurnStarted -> if (event.subagentId == null) {
                closeStretch(at)
                turnStart = at
                turnModel = event.model
                boundary = at
            }
            is ProviderEvent.ItemStarted -> if (event.subagentId == null) {
                when (event.kind) {
                    ItemKind.UserMessage -> {
                        closeStretch(at)
                        blocks += UserBlock(event.itemId, readText(readDetailObject(event.detail), "text").orEmpty(), at)
                    }
                    ItemKind.AssistantMessage -> {
                        closeStretch(at)
                        val text = texts[event.itemId]?.toString().orEmpty() + tails[event.itemId].orEmpty()
                        if (text.isNotBlank()) blocks += AgentBlock(event.itemId, text, at, turnModel)
                    }
                    else -> {
                        val building = stretch ?: BuildingStretch("work-${event.itemId}", boundary ?: at).also { stretch = it }
                        building.items += buildWorkItem(event, statuses[event.itemId])
                    }
                }
            }
            is ProviderEvent.ItemCompleted ->
                if (event.subagentId == null && event.kind == ItemKind.AssistantMessage) boundary = at
            is ProviderEvent.TurnCompleted -> if (event.subagentId == null) {
                closeStretch(at)
                val start = turnStart
                if (event.state != TurnState.Completed && start != null) {
                    blocks += EndingBlock("end-${event.turnId}", event.state, at - start)
                }
                turnStart = null
            }
            is ProviderEvent.RuntimeWarning -> if (event.subagentId == null) {
                blocks += WarningBlock("warning-${row.position}", event.message, at)
            }
            is ProviderEvent.RequestOpened -> if (event.subagentId == null && event.request.requestId in openIds) {
                closeStretch(at)
                blocks += WaitingBlock("waiting-${event.request.requestId}", event.request.requestId, at)
            }
            else -> Unit
        }
    }
    stretch?.let { building ->
        val items = building.items.filter { it.kind != ItemKind.Reasoning }
        if (items.isNotEmpty()) blocks += WorkBlock(building.key, items, building.startedAt, null)
    }
    return blocks
}

/** A work stretch while it is built. */
private class BuildingStretch(val key: String, val startedAt: Instant) {
    val items = mutableListOf<WorkItem>()
}

/**
 * Builds the work item an `item.started` row starts. Every key of the detail is optional,
 * because each harness spells its detail its own way:
 *
 * - a command reads `command`, else the tool input's `command`;
 * - a file change or read reads `paths`, `path`, else the input's `file_path`, `notebook_path`
 *   or `path`;
 * - a search reads `pattern` and `path`, or `query`;
 * - anything else reads `description`, else the tool's `name`.
 */
private fun buildWorkItem(event: ProviderEvent.ItemStarted, status: ItemStatus?): WorkItem {
    val detail = readDetailObject(event.detail)
    val input = detail?.get("input") as? JsonObject
    val paths = when (event.kind) {
        ItemKind.FileRead, ItemKind.FileChange -> {
            val listed = (detail?.get("paths") as? JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content }
            listed ?: listOfNotNull(
                readText(detail, "path") ?: readText(input, "file_path") ?: readText(input, "notebook_path") ?: readText(input, "path"),
            )
        }
        else -> emptyList()
    }
    val (target, isCode) = when (event.kind) {
        ItemKind.CommandExecution -> (readText(detail, "command") ?: readText(input, "command")).orEmpty() to true
        ItemKind.FileRead, ItemKind.FileChange -> paths.joinToString(", ") to true
        ItemKind.FileSearch -> {
            val pattern = readText(detail, "pattern") ?: readText(input, "pattern")
            val path = readText(detail, "path")
            listOfNotNull(pattern, path).joinToString(" in ") to true
        }
        ItemKind.WebSearch -> (readText(detail, "query") ?: readText(input, "query")).orEmpty() to false
        else -> (readText(detail, "description") ?: readText(input, "description") ?: readText(detail, "name")).orEmpty() to false
    }
    return WorkItem(event.itemId, event.kind, target, isCode, paths, status)
}

/**
 * Returns an item's [detail] when it is a JSON object, and null otherwise. The protocol allows
 * any JSON as the detail, and only an object has keys to read.
 */
private fun readDetailObject(detail: JsonElement?): JsonObject? = detail as? JsonObject

/** Returns the string at [key] of [json], or null when it is missing or not a string. */
private fun readText(json: JsonObject?, key: String): String? =
    (json?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

/**
 * Returns the summary on a work stretch's divider: one phrase per item kind, such as "ran 2
 * commands", in the order each kind first appears. File changes and reads count distinct files.
 *
 * Ported from `summarizeWork` in packages/client-core/src/threads/work-summary.ts.
 */
fun summarizeWork(items: List<WorkItem>): List<String> =
    items.groupBy { it.kind }.mapNotNull { (kind, ofKind) ->
        val count = if (kind == ItemKind.FileChange || kind == ItemKind.FileRead) countDistinctFiles(ofKind) else ofKind.size
        when (kind) {
            ItemKind.CommandExecution -> "ran ${formatCount(count, "command")}"
            ItemKind.FileChange -> "edited ${formatCount(count, "file")}"
            ItemKind.FileRead -> "read ${formatCount(count, "file")}"
            ItemKind.FileSearch -> if (count == 1) "searched once" else "searched $count times"
            ItemKind.WebSearch -> if (count == 1) "searched the web" else "searched the web $count times"
            ItemKind.ToolCall -> "used ${formatCount(count, "tool")}"
            ItemKind.Subagent -> "ran ${formatCount(count, "subagent")}"
            ItemKind.Plan -> if (count == 1) "made a plan" else "made $count plans"
            ItemKind.ContextCompaction -> if (count == 1) "compacted the context" else "compacted the context $count times"
            ItemKind.Error -> "hit ${formatCount(count, "error")}"
            ItemKind.Reasoning, ItemKind.UserMessage, ItemKind.AssistantMessage -> null
            // The wire's own "unknown" and any kind this build does not know.
            else -> "did ${formatCount(count, "other step")}"
        }
    }

/** Returns how many files [items] name: the distinct paths, plus one per item that names none. */
private fun countDistinctFiles(items: List<WorkItem>): Int =
    items.flatMap { it.paths }.toSet().size + items.count { it.paths.isEmpty() }

/** Returns [count] followed by [noun], with an "s" when the count is not one. */
private fun formatCount(count: Int, noun: String): String = "$count $noun${if (count == 1) "" else "s"}"

/**
 * Formats a duration for the "Worked for" divider: "31s", "12m 4s", "1h 4m". Seconds are left
 * out from an hour on, and a negative duration reads "0s".
 *
 * Ported from `formatDuration` in packages/client-core/src/threads/duration.ts.
 */
fun formatDuration(duration: Duration): String {
    val totalSeconds = maxOf(0L, Math.round(duration.inWholeMilliseconds / 1000.0))
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    return when {
        hours > 0 -> "${hours}h ${minutes}m"
        minutes > 0 -> "${minutes}m ${seconds}s"
        else -> "${seconds}s"
    }
}
