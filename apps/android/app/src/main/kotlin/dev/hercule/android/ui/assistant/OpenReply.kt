package dev.hercule.android.ui.assistant

import dev.hercule.android.wire.AssistantReply
import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.ConversationSenderRole
import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.ProviderEvent
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionStatus
import dev.hercule.android.wire.StreamKind
import dev.hercule.android.wire.TranscriptRow
import dev.hercule.android.wire.TurnState
import kotlin.time.Instant

/*
 * The reply an assistant is still writing, as the desktop decides it. A port of
 * `decideOpenReply` in `packages/client-core/src/assistants/conversation-blocks.ts`, without the
 * pose, which the screen reads from the session.
 *
 * Two sources overlap: a reply is first text in the running turn of the current session, and
 * is then stored as a message with the same `turnId`. The open reply holds only the text not
 * stored yet, so no text is drawn twice. Which text the controller stores depends on the
 * assistant's reply mode, so the open reply follows the same rules. Text is never compared: a
 * stored reply names the assistant text it holds by its `itemId`, the id the text's transcript
 * rows carry. A reply with a null `itemId` joins every text of its turn that no reply held
 * before it.
 */

/**
 * The reply the assistant is writing: the running turn's texts that no stored message holds
 * yet. [items] is empty while the assistant works and has written nothing that will be stored.
 */
data class OpenReply(
    /** The running turn, or null while the reply stands for a turn whose first row has not arrived. */
    val turnId: String?,
    /** The texts, in the order the assistant started writing them. */
    val items: List<OpenReplyItem>,
    /**
     * The item the assistant is still writing, whose streaming tail goes after its row text, or
     * null when no item of [items] is being written.
     */
    val openItemId: String?,
)

/** One assistant text of the running turn that is not stored as a message yet. */
data class OpenReplyItem(
    val itemId: String,
    /** The text the transcript rows hold. The words still streaming are in the tail, not here. */
    val rowText: String,
)

/** An assistant text of the running turn, as its transcript rows hold it. */
private class AssistantText(val itemId: String) {
    /** The text of its rows that the controller reads for a reply. */
    var rowText = ""

    /** How the item completed, or null while it has not. */
    var status: ItemStatus? = null
}

/** How the running turn ended: the time of the row that ended it, and its state, or null when the session exited or started again first. */
private class TurnEnd(val at: String, val state: TurnState?)

/** The running turn as its transcript rows hold it. */
private class RunningTurn(
    val turnId: String,
    /** In the order the items were placed. */
    val texts: List<AssistantText>,
    /** The ids of the texts that completed, in the order they completed. In segments mode the controller stores texts in this order. */
    val completedIds: List<String>,
    /** The text whose first text row came last, or null when no text has a row. */
    val lastText: AssistantText?,
    /** Null while the rows hold no end of the turn. */
    val end: TurnEnd?,
)

/**
 * Reads the running turn from [rows], or returns null when they hold no `turn.started`. The
 * turn is the one the newest `turn.started` names, and only the rows from it on are read.
 *
 * The texts are read the way the controller reads them when it stores a reply:
 *
 * - Only assistant text rows that name the running turn count.
 * - In turn-end mode, the controller reads the turn's text rows from its start, so a text is
 *   placed by its `item.started`, or by its first text row when that comes first.
 * - In segments mode, the controller reads an item's text rows from its `item.started` on, and
 *   stores nothing for an item with no `item.started`. So text rows before it are skipped.
 *
 * The turn ends at its `turn.completed`, or, cut short, at a later `session.exited` or
 * `session.started`. An item is completed by its `item.completed`, found by item id, because a
 * harness can complete an item under a later turn.
 */
private fun readRunningTurn(rows: List<TranscriptRow>, reply: AssistantReply): RunningTurn? {
    val start = rows.indexOfLast { it.event is ProviderEvent.TurnStarted }
    val turnId = (rows.getOrNull(start)?.event as? ProviderEvent.TurnStarted)?.turnId ?: return null

    val texts = mutableListOf<AssistantText>()
    val byId = HashMap<String, AssistantText>()
    val withTextRow = HashSet<String>()
    val completedIds = mutableListOf<String>()
    var lastText: AssistantText? = null
    var end: TurnEnd? = null
    fun placeText(itemId: String) = AssistantText(itemId).also {
        texts += it
        byId[itemId] = it
    }

    for (row in rows.subList(start + 1, rows.size)) {
        when (val event = row.event) {
            is ProviderEvent.TurnCompleted -> if (event.turnId == turnId && end == null) end = TurnEnd(row.at, event.state)
            is ProviderEvent.SessionExited, ProviderEvent.SessionStarted -> if (end == null) end = TurnEnd(row.at, null)
            is ProviderEvent.ItemStarted ->
                if (event.kind == ItemKind.AssistantMessage && event.turnId == turnId && event.itemId !in byId) placeText(event.itemId)
            is ProviderEvent.ContentDelta -> {
                if (event.streamKind != StreamKind.AssistantText || event.turnId != turnId) continue
                val text = byId[event.itemId] ?: (if (reply == AssistantReply.TurnEnd) placeText(event.itemId) else null) ?: continue
                text.rowText += event.delta
                if (withTextRow.add(text.itemId)) lastText = text
            }
            is ProviderEvent.ItemCompleted -> {
                val text = byId[event.itemId]
                if (text != null && text.status == null) {
                    text.status = event.status
                    completedIds += event.itemId
                }
            }
            else -> Unit
        }
    }
    return RunningTurn(turnId, texts, completedIds, lastText, end)
}

/**
 * Returns the running turn's texts that the controller stores, or has stored, when it stores
 * one reply per turn (turn-end mode). The caller hides those a stored reply holds already:
 *
 * - While the turn runs, the text the assistant is still writing, when it is the last one
 *   placed. Its words are in the tail until it completes, so its rows may hold no text yet.
 * - Else the text whose first text row came last, when it holds text. The controller stores
 *   that one when the turn completes.
 * - When the turn failed or was stopped, every text that holds text, because the controller
 *   then stores them joined.
 * - None when the turn was cut short: the controller stores no reply then.
 */
private fun listTurnEndTexts(turn: RunningTurn): List<AssistantText> {
    val end = turn.end
    if (end != null && end.state != TurnState.Completed) {
        return if (end.state == null) emptyList() else turn.texts.filter { it.rowText.isNotEmpty() }
    }
    val last = turn.texts.lastOrNull()
    if (last != null && last.status == null && end == null) return listOf(last)
    return listOfNotNull(turn.lastText?.takeIf { it.rowText.isNotEmpty() })
}

/**
 * Returns the running turn's texts that no stored reply holds yet, when the controller stores
 * a reply per text (segments mode). [storedItemIds] are the texts the turn's stored replies
 * hold.
 *
 * The controller stores a text when it completes with status completed and holds text, so
 * texts are stored in the order they complete, and a stored text means every text that
 * completed before it is stored too. The texts shown are those that completed after the last
 * stored one and will be stored, and, while the turn runs, those still being written.
 */
private fun listSegmentTexts(turn: RunningTurn, storedItemIds: Set<String>): List<AssistantText> {
    val lastStored = turn.completedIds.indexOfLast { it in storedItemIds }
    return turn.texts.filter { text ->
        val status = text.status
        if (status == null) {
            turn.end == null
        } else {
            status == ItemStatus.Completed && text.rowText.isNotEmpty() && turn.completedIds.indexOf(text.itemId) > lastStored
        }
    }
}

/**
 * Checks whether the owner sent a message after the running turn ended, so the busy session is
 * about to start the turn that answers it. The end is the row that ended the turn, compared by
 * time, or, before that row arrived, the turn's [joinedReply], compared by position. Returns
 * false while the turn has not ended.
 */
private fun isOwnerMessageAfterTurnEnd(
    messages: List<ConversationMessage>,
    turn: RunningTurn,
    joinedReply: ConversationMessage?,
): Boolean {
    val ownerMessage = messages.lastOrNull { it.senderRole == ConversationSenderRole.Owner } ?: return false
    val end = turn.end
    if (end != null) {
        // The runner writes the time; one it wrote badly compares as false, as the desktop's Date.parse does.
        val endedAt = try {
            Instant.parse(end.at)
        } catch (_: IllegalArgumentException) {
            return false
        }
        return ownerMessage.createdAt > endedAt
    }
    return joinedReply != null && ownerMessage.position > joinedReply.position
}

/**
 * Decides the open reply: the reply the assistant is writing in the running turn, as far as no
 * stored message holds it. Returns null when there is none.
 *
 * - [messages] are the Conversation's messages held, oldest first.
 * - [runningTurnRows] are the current session's rows, oldest first. Only the rows from the
 *   newest `turn.started` on are read.
 * - [session] is the current session, or null when there is none.
 * - [reply] is the assistant's reply mode. In turn-end mode the turn's newest text shows, or
 *   every text when the turn failed or was stopped; in segments mode, the texts that completed
 *   after the last stored one, and those being written.
 *
 * A text is hidden once a stored reply of the turn holds it: a reply with the turn's `turnId`
 * and the text's `itemId`. A reply with the turn's `turnId` and a null `itemId` is a joined
 * reply, and once it is stored nothing of the turn shows. Both rules apply in either mode,
 * because a change of mode applies at once, also to a running turn.
 *
 * While the session is busy, an open reply with no items is returned:
 *
 * - while the turn has not ended, as when it only uses tools or waits on a Request;
 * - when the rows hold no turn yet;
 * - when the turn has ended and the owner sent a message after its end. That reply stands for
 *   the next turn, so its `turnId` is null.
 *
 * A turn that ended with no text to store, and no owner message after it, leaves no open reply,
 * even while the session still reads as busy.
 */
fun decideOpenReply(
    messages: List<ConversationMessage>,
    runningTurnRows: List<TranscriptRow>,
    session: Session?,
    reply: AssistantReply,
): OpenReply? {
    val busy = session?.status == SessionStatus.Busy
    val nothingYet = OpenReply(turnId = null, items = emptyList(), openItemId = null)
    val turn = readRunningTurn(runningTurnRows, reply) ?: return nothingYet.takeIf { busy }

    val storedReplies = messages.filter { it.senderRole == ConversationSenderRole.Assistant && it.turnId == turn.turnId }
    // A joined reply is stored only when its turn ends, so it ends the turn even while the
    // turn's `turn.completed` row is on its way.
    val joinedReply = storedReplies.find { it.itemId == null }
    val storedItemIds = storedReplies.mapNotNullTo(HashSet()) { it.itemId }
    val ended = turn.end != null || joinedReply != null
    if (ended && busy && isOwnerMessageAfterTurnEnd(messages, turn, joinedReply)) return nothingYet
    val shown = when {
        joinedReply != null -> emptyList()
        reply == AssistantReply.TurnEnd -> listTurnEndTexts(turn).filter { it.itemId !in storedItemIds }
        else -> listSegmentTexts(turn, storedItemIds)
    }
    if (shown.isEmpty() && (ended || !busy)) return null

    val openItemId = if (ended) null else findOpenItem(runningTurnRows)
    return OpenReply(
        turnId = turn.turnId,
        items = shown.map { OpenReplyItem(it.itemId, it.rowText) },
        openItemId = openItemId?.takeIf { id -> shown.any { it.itemId == id } },
    )
}

/**
 * Builds the text of [openReply] the screen draws: each item's row text, with the streaming
 * tail from [tails] after the item being written, the items separated by a blank line as
 * paragraphs. Returns null when the reply holds no text yet.
 */
fun buildOpenReplyText(openReply: OpenReply?, tails: Map<String, String>): String? {
    val texts = openReply?.items.orEmpty().map { item ->
        if (item.itemId == openReply?.openItemId) item.rowText + tails[item.itemId].orEmpty() else item.rowText
    }
    return texts.filter { it.isNotEmpty() }.joinToString("\n\n").ifEmpty { null }
}

/**
 * Returns the id of the item the transcript is still in the middle of, or null: the latest item
 * whose `item.started` has no `item.completed` yet. A user message is never open. A port of
 * client-core's `findOpenItem`.
 */
private fun findOpenItem(rows: List<TranscriptRow>): String? {
    val started = mutableListOf<String>()
    val completed = HashSet<String>()
    for (row in rows) {
        when (val event = row.event) {
            is ProviderEvent.ItemStarted -> if (event.kind != ItemKind.UserMessage) started += event.itemId
            is ProviderEvent.ItemCompleted -> if (event.kind != ItemKind.UserMessage) completed += event.itemId
            else -> Unit
        }
    }
    return started.lastOrNull { it !in completed }
}
