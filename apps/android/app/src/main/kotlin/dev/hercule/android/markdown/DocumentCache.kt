package dev.hercule.android.markdown

/**
 * Which message a parse belongs to: the transcript it is in (a session's or a conversation's, by
 * its id), its id there, and the two options of [parseMarkdown] it is parsed with. A message id
 * is unique only within its transcript, so two transcripts' messages never share an entry.
 */
data class DocumentKey(val transcriptId: String, val messageId: String, val breaks: Boolean, val embeddedHtml: Boolean)

/**
 * The parsed documents of the messages the screens draw, kept so that a message whose text did
 * not change is never parsed again, also when its screen is left and opened again.
 *
 * Each message keeps one entry: the document of the text it was parsed from last. A message whose
 * text changes replaces its entry, so a reply being written holds only its newest finished part.
 *
 * The cache is bounded by the size it holds, measured in characters of message text, which a
 * document's size follows: past [maxChars], the entries used longest ago are dropped first.
 *
 * Thread-safe: every method takes the cache's lock, and none parses while holding it.
 */
class DocumentCache(private val maxChars: Int = DEFAULT_MAX_CHARS) {
    private class Entry(val text: String, val document: MarkdownDocument)

    // In access order, so the first entry is the one used longest ago.
    private val entries = LinkedHashMap<DocumentKey, Entry>(16, 0.75f, true)
    private var heldChars = 0

    /** Returns the document of [key] parsed from exactly [text], or null when the cache holds none. */
    @Synchronized
    fun read(key: DocumentKey, text: String): MarkdownDocument? = entries[key]?.takeIf { it.text == text }?.document

    /** Stores [document], parsed from [text], as [key]'s entry, replacing the one it had, and drops the oldest entries past the bound. */
    @Synchronized
    fun store(key: DocumentKey, text: String, document: MarkdownDocument) {
        entries.put(key, Entry(text, document))?.let { heldChars -= it.text.length }
        heldChars += text.length
        val oldest = entries.entries.iterator()
        while (heldChars > maxChars && oldest.hasNext()) {
            val entry = oldest.next()
            // The entry just stored stays, however large, so its screen can still use it.
            if (entry.key == key) continue
            heldChars -= entry.value.text.length
            oldest.remove()
        }
    }

    /** Drops the entries of the transcript [transcriptId] whose key is not in [kept]: the messages that left its transcript. */
    @Synchronized
    fun retain(transcriptId: String, kept: Set<DocumentKey>) {
        val iterator = entries.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (entry.key.transcriptId == transcriptId && entry.key !in kept) {
                heldChars -= entry.value.text.length
                iterator.remove()
            }
        }
    }

    /** Returns how many characters of message text the entries hold. */
    @Synchronized
    fun countHeldChars(): Int = heldChars

    private companion object {
        /**
         * About a million characters of message text: the replies of some fifty long threads.
         * A document takes a few bytes per character of its text, so a few megabytes in all.
         */
        const val DEFAULT_MAX_CHARS = 1_000_000
    }
}
