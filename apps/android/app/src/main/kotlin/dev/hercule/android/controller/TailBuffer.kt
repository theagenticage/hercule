package dev.hercule.android.controller

import dev.hercule.android.wire.HarnessEvent
import dev.hercule.android.wire.StreamKind
import dev.hercule.android.wire.TapItem
import dev.hercule.android.wire.TranscriptRow

/**
 * The streaming tails of one thread: for each assistant message, the text the token tap has
 * delivered and no stream row holds yet. A port of `packages/client-core/src/threads/tail-buffer.ts`,
 * so the app streams a reply the way the web app does.
 *
 * Two topics carry a message's text:
 *
 * - `session:<id>:tap` sends each token as it happens. It is never stored or replayed, so a
 *   token sent while nobody listens is lost.
 * - `session:<id>:stream` sends stored rows. The controller writes an item's tokens as one
 *   `content.delta` row when the item or its turn ends, or when the held text reaches 4 KB.
 *
 * Taps arrive before the row that holds their text. So when a row lands, its text is removed
 * from the front of the tail and the rest stays.
 *
 * A tap carries no offset, so a tail that missed taps cannot be lined up with the rows again.
 * Such an item is skipped: its tail is dropped and its taps are ignored until it completes.
 * Its text still shows, because it arrives in the rows.
 *
 * Not thread-safe: the caller serializes every call.
 */
class TailBuffer {
    private val tails = HashMap<String, String>()
    private val skipped = HashSet<String>()

    /**
     * Adds one tap to its item's tail. Only assistant text is kept: reasoning and command
     * output are not the answer. A tap may arrive before its item's `item.started` row.
     */
    fun appendTap(tap: TapItem) {
        if (tap.streamKind != StreamKind.AssistantText || tap.itemId in skipped) return
        tails[tap.itemId] = tails[tap.itemId].orEmpty() + tap.delta
    }

    /**
     * Applies the rows of one stream delivery that the caller's transcript does not hold yet.
     * A row applied twice would no longer match its tail, so only new rows may be passed.
     *
     * - An assistant text row removes its text from the front of its item's tail, or skips
     *   the item when the tail does not start with that text.
     * - An `item.completed` row forgets the item, skipped or not.
     */
    fun applyRows(rows: List<TranscriptRow>) {
        for (row in rows) {
            when (val event = row.event) {
                is HarnessEvent.ItemCompleted -> {
                    tails -= event.itemId
                    skipped -= event.itemId
                }
                is HarnessEvent.ContentDelta -> {
                    if (event.streamKind != StreamKind.AssistantText || event.itemId in skipped) continue
                    val tail = tails[event.itemId].orEmpty()
                    if (tail.startsWith(event.delta)) {
                        tails[event.itemId] = tail.substring(event.delta.length)
                    } else {
                        skipItem(event.itemId)
                    }
                }
                else -> Unit
            }
        }
    }

    /**
     * Skips every item that may have missed taps or rows: the items open in [rows], and every
     * item that still has a tail. Call it with the transcript the caller holds each time the
     * tap is subscribed, first or again, and when the stream is reset.
     */
    fun skipOpenItems(rows: List<TranscriptRow>) {
        for (itemId in findOpenItemIds(rows) + tails.keys.toList()) skipItem(itemId)
    }

    /** Returns an item's tail, or "" for a skipped item or an item with no tail. */
    fun readTail(itemId: String): String = tails[itemId].orEmpty()

    /** Returns a copy of every tail, by item id. */
    fun copyTails(): Map<String, String> = tails.filterValues { it.isNotEmpty() }

    private fun skipItem(itemId: String) {
        tails -= itemId
        skipped += itemId
    }
}

/** Returns the ids of the items that started in [rows] and have not completed. */
private fun findOpenItemIds(rows: List<TranscriptRow>): Set<String> {
    val open = LinkedHashSet<String>()
    for (row in rows) {
        when (val event = row.event) {
            is HarnessEvent.ItemStarted -> open += event.itemId
            is HarnessEvent.ItemCompleted -> open -= event.itemId
            else -> Unit
        }
    }
    return open
}
