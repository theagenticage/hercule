package dev.hercule.android.ui.markdown

import androidx.compose.runtime.Immutable
import dev.hercule.android.markdown.DocumentCache
import dev.hercule.android.markdown.DocumentKey
import dev.hercule.android.markdown.MarkdownDocument
import dev.hercule.android.markdown.parseMarkdown
import dev.hercule.android.markdown.splitStreamingText
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * What a message's row draws, all from one revision of its text, so the row never draws a word
 * twice or leaves one out:
 *
 * - [document], the markdown of the text's start;
 * - [open], the rest of the text, drawn as plain text after it, or null when nothing follows. While
 *   the agent writes, that is the paragraph being written. It also holds the text a parse has not
 *   reached yet: while the newer parse runs, the document before it stays on screen;
 * - [resets], how many times the text stopped starting with the text before, which shuts the
 *   details blocks the user opened.
 */
@Immutable
class ParsedMessage(val document: MarkdownDocument, val open: String?, val resets: Int)

/**
 * Parses the messages of one screen off the main thread, and hands each row the result of the
 * newest revision of its text that has been parsed (#747). One instance belongs to one screen's
 * view model, which calls [startPass], [read] for each message and [finishPass] each time its
 * state changes, from one coroutine at a time.
 *
 * - A message whose text did not change is never parsed again: [cache] holds its document, also
 *   when the screen is left and opened again.
 * - The newest messages are parsed at once, inside [read], until [IMMEDIATE_PARSE_CHARS]
 *   characters have been parsed in the pass, so the screen opens on rows that are already parsed.
 *   The rest are parsed in the background, newest first, by one worker per screen, and at most
 *   [PARSES_AT_ONCE] parses run at once in the whole app.
 * - A message whose text grew keeps the document of its older text, with the rest as plain text,
 *   until its newer text is parsed. Each pass queues only the newest text of each message, so a
 *   text that changed again before its parse started is never parsed, and a parse that finishes
 *   late is used only while the message still has that text.
 *
 * [parsed] counts the background parses that finished. The view model reads the messages again
 * when it changes.
 */
class MessageDocuments(
    private val cache: DocumentCache,
    scope: CoroutineScope,
    private val parseDispatcher: CoroutineDispatcher = SHARED_PARSE_DISPATCHER,
) {
    /** One message's text as this screen saw it last. */
    private class MessageState {
        var text: String? = null
        var settled = ""
        var resets = 0
        var shownText: String? = null
        var shownDocument: MarkdownDocument? = null
        var returned: ParsedMessage? = null
    }

    private val states = HashMap<DocumentKey, MessageState>()
    private val lock = Any()

    // The texts waiting for the worker, by message, in the order of the pass that queued them.
    private val queued = LinkedHashMap<DocumentKey, String>()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var immediateChars = 0
    private val mutableParsed = MutableStateFlow(0L)

    /** How many background parses have finished. */
    val parsed: StateFlow<Long> = mutableParsed.asStateFlow()

    init {
        scope.launch(parseDispatcher) {
            while (true) {
                wake.receive()
                while (true) {
                    val (key, text) = synchronized(lock) {
                        val next = queued.entries.firstOrNull() ?: return@synchronized null
                        queued.remove(next.key)
                        next.key to next.value
                    } ?: break
                    if (cache.read(key, text) != null) continue
                    cache.store(key, text, parseDocument(text, key))
                    mutableParsed.update { it + 1 }
                }
            }
        }
    }

    /** Starts a pass over the screen's messages: the queue is replaced by what this pass queues. */
    fun startPass() {
        immediateChars = 0
        synchronized(lock) { queued.clear() }
    }

    /**
     * Returns what the row of the message [messageId] of the transcript [transcriptId], by [author],
     * draws for its [text], which the agent is still [writing] or not, or null when no document
     * of it is ready, which the row then parses itself. Call it for the newest message first.
     */
    fun read(transcriptId: String, messageId: String, author: MessageAuthor, text: String, writing: Boolean): ParsedMessage? {
        val key = buildDocumentKey(transcriptId, messageId, author)
        val state = states.getOrPut(key) { MessageState() }
        val before = state.text
        // An unchanged message hands over the same string, which needs no comparing.
        if (before != null && text !== before && !text.startsWith(before)) {
            // The text was replaced, not extended: nothing parsed from the old text may be drawn.
            state.resets++
            state.settled = ""
            state.shownText = null
            state.shownDocument = null
        }
        state.text = text
        val source: String
        val open: String?
        if (writing) {
            val split = splitStreamingText(text, state.settled)
            // The same string instance while the finished part does not change, so the cache
            // compares it at once.
            if (split.settled.length != state.settled.length || !split.settled.startsWith(state.settled)) state.settled = split.settled
            source = state.settled
            open = split.open
        } else {
            source = text
            open = null
        }
        var document = cache.read(key, source)
        if (document == null && state.shownDocument == null && immediateChars < IMMEDIATE_PARSE_CHARS) {
            document = parseDocument(source, key)
            cache.store(key, source, document)
            immediateChars += source.length
        }
        if (document != null) {
            state.shownText = source
            state.shownDocument = document
            return buildResult(state, document, open)
        }
        synchronized(lock) { queued[key] = source }
        val shownText = state.shownText ?: return null
        val shownDocument = state.shownDocument ?: return null
        // The document of an older revision, with the rest of the text after it as plain text.
        // While the agent writes, the rest is drawn even when empty, as the caret's line.
        val rest = text.substring(shownText.length)
        return buildResult(state, shownDocument, rest.takeIf { writing || it.isNotEmpty() })
    }

    /**
     * Ends the pass that read the transcript [transcriptId]'s messages [kept]: forgets every other
     * message of it, here and in the cache, and wakes the worker for what the pass queued.
     */
    fun finishPass(transcriptId: String, kept: Set<DocumentKey>) {
        if (states.keys.any { it.transcriptId == transcriptId && it !in kept }) {
            states.keys.removeAll { it.transcriptId == transcriptId && it !in kept }
            cache.retain(transcriptId, kept)
        }
        wake.trySend(Unit)
    }

    /** Returns the result for [state], the one returned before when nothing in it changed, so the row sees the same instance. */
    private fun buildResult(state: MessageState, document: MarkdownDocument, open: String?): ParsedMessage {
        val returned = state.returned
        if (returned != null && returned.document === document && returned.open == open && returned.resets == state.resets) return returned
        return ParsedMessage(document, open, state.resets).also { state.returned = it }
    }

    private companion object {
        /** How many characters a pass parses before it hands the rest to the worker: more than a screen holds. */
        const val IMMEDIATE_PARSE_CHARS = 8_000

        /** How many parses may run at once in the whole app. */
        const val PARSES_AT_ONCE = 2

        @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
        val SHARED_PARSE_DISPATCHER: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(PARSES_AT_ONCE)
    }
}

/** Returns the key of the message [messageId] of the transcript [transcriptId] by [author], as [MessageDocuments] keys it. */
fun buildDocumentKey(transcriptId: String, messageId: String, author: MessageAuthor): DocumentKey =
    DocumentKey(transcriptId, messageId, author.breaks, author.embeddedHtml)

/** Parses [text] with the options of [key]. */
private fun parseDocument(text: String, key: DocumentKey): MarkdownDocument =
    parseMarkdown(text, breaks = key.breaks, embeddedHtml = key.embeddedHtml)
