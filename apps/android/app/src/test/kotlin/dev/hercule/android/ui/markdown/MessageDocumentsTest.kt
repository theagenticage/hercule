package dev.hercule.android.ui.markdown

import dev.hercule.android.markdown.DocumentCache
import dev.hercule.android.markdown.DocumentKey
import dev.hercule.android.markdown.parseMarkdown
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * Tests [MessageDocuments] and its [DocumentCache] by what a screen reads from them: each result
 * comes from one revision of a message's text, a parse that is out of date is never drawn, an
 * unchanged message is never parsed again, and messages that leave the transcript are forgotten.
 *
 * The background parses run on the test's dispatcher, so each test decides when they finish: `runCurrent`
 * runs them, as `advanceUntilIdle` does not run work in the background scope.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MessageDocumentsTest {
    private val dispatcher = StandardTestDispatcher()

    private fun TestScope.open(cache: DocumentCache = DocumentCache()) = MessageDocuments(cache, backgroundScope, dispatcher)

    /** Reads one message in a pass of its own, as a view model's pass over one message does. */
    private fun MessageDocuments.readAlone(text: String, writing: Boolean, transcriptId: String = "s1", messageId: String = "m1"): ParsedMessage? {
        startPass()
        val parsed = read(transcriptId, messageId, MessageAuthor.Agent, text, writing)
        finishPass(transcriptId, setOf(buildDocumentKey(transcriptId, messageId, MessageAuthor.Agent)))
        return parsed
    }

    /** Checks that [parsed] draws exactly [text]: a document of the text's start, and the rest as plain text. */
    private fun assertDrawsOneRevision(text: String, parsed: ParsedMessage) {
        val open = parsed.open.orEmpty()
        assertTrue(text.endsWith(open), "The plain text is the end of the text")
        assertEquals(parseMarkdown(text.dropLast(open.length)), parsed.document, "The document is the text before the plain text")
    }

    @Test
    fun `draws every revision of a streamed reply as one revision, and the newest finished part once parsed`() = runTest(dispatcher) {
        val documents = open()
        val reply = (1..40).joinToString("\n\n") { "Paragraph $it with **bold** and `code`." }
        var text = ""
        for (token in reply.chunked(9)) {
            text += token
            val parsed = assertNotNull(documents.readAlone(text, writing = true))
            assertDrawsOneRevision(text, parsed)
            // Some tokens let the worker run, others arrive before it does.
            if (text.length % 2 == 0) runCurrent()
        }
        runCurrent()
        val ended = assertNotNull(documents.readAlone(text, writing = false))
        runCurrent()
        val parsedEnd = assertNotNull(documents.readAlone(text, writing = false))

        assertDrawsOneRevision(text, ended)
        assertNull(parsedEnd.open)
        assertEquals(parseMarkdown(text), parsedEnd.document)
    }

    @Test
    fun `never draws a slow parse of the finished part once the message has ended`() = runTest(dispatcher) {
        val documents = open()
        documents.readAlone("First.\n\n", writing = true)
        // The second paragraph finishes, and its parse waits for the worker...
        val writing = assertNotNull(documents.readAlone("First.\n\nSecond.\n\nThi", writing = true))
        assertEquals(parseMarkdown("First.\n\n"), writing.document)
        // ...and the message ends before the worker ran.
        val text = "First.\n\nSecond.\n\nThird, the end."
        val ended = assertNotNull(documents.readAlone(text, writing = false))
        assertDrawsOneRevision(text, ended)

        runCurrent()
        val parsed = assertNotNull(documents.readAlone(text, writing = false))

        assertEquals(parseMarkdown(text), parsed.document)
        assertNull(parsed.open)
    }

    @Test
    fun `draws nothing parsed from a text that was replaced by a shorter one, and shuts its details`() = runTest(dispatcher) {
        val documents = open()
        val long = "Streamed words, then **more**.\n\nAnd a second paragraph."
        val before = assertNotNull(documents.readAlone(long, writing = false))
        // A reconnect dropped the streamed words, and the stored text is shorter.
        val stored = "Streamed words."
        val after = documents.readAlone(stored, writing = true)

        // The text is the newest message, so it is parsed at once; the old document is never drawn.
        assertNotNull(after)
        assertDrawsOneRevision(stored, after)
        assertEquals(before.resets + 1, after.resets)
    }

    @Test
    fun `parses an unchanged message once, also when the screen is opened again`() = runTest(dispatcher) {
        val cache = DocumentCache()
        val text = "A finished message with a [link](https://example.com)."
        val first = assertNotNull(open(cache).readAlone(text, writing = false))
        val again = open(cache)

        val reopened = assertNotNull(again.readAlone(text, writing = false))
        val next = assertNotNull(again.readAlone(text, writing = false))

        assertSame(first.document, reopened.document)
        assertSame(reopened, next)
    }

    @Test
    fun `keeps the messages of two transcripts apart when they have the same id`() = runTest(dispatcher) {
        val documents = open()

        val one = assertNotNull(documents.readAlone("In the first session.", writing = false, transcriptId = "s1"))
        val two = assertNotNull(documents.readAlone("In the second session.", writing = false, transcriptId = "s2"))

        assertEquals(parseMarkdown("In the first session."), one.document)
        assertEquals(parseMarkdown("In the second session."), two.document)
    }

    @Test
    fun `parses the newest messages at once and the older ones in the background, newest first`() = runTest(dispatcher) {
        val documents = open()
        val texts = (1..12).map { "Message $it: " + "word ".repeat(300) }

        documents.startPass()
        // The newest message first, as the screens read them.
        val read = texts.indices.reversed().associateWith { documents.read("s1", "m$it", MessageAuthor.Agent, texts[it], writing = false) }
        documents.finishPass("s1", texts.indices.map { buildDocumentKey("s1", "m$it", MessageAuthor.Agent) }.toSet())
        val parsedAtOnce = read.filterValues { it != null }.keys
        runCurrent()
        documents.startPass()
        val later = texts.indices.reversed().map { documents.read("s1", "m$it", MessageAuthor.Agent, texts[it], writing = false) }

        assertTrue(11 in parsedAtOnce && 0 !in parsedAtOnce, "The newest are parsed at once, the oldest are not: $parsedAtOnce")
        assertTrue(later.all { it != null }, "The worker parsed the rest")
    }

    @Test
    fun `forgets the messages that left the transcript`() = runTest(dispatcher) {
        val cache = DocumentCache()
        val documents = open(cache)
        documents.startPass()
        documents.read("s1", "kept", MessageAuthor.Agent, "Kept.", writing = false)
        documents.read("s1", "gone", MessageAuthor.Agent, "Gone.", writing = false)
        documents.read("s2", "other", MessageAuthor.Agent, "Another session's.", writing = false)
        documents.finishPass("s1", setOf(buildDocumentKey("s1", "kept", MessageAuthor.Agent), buildDocumentKey("s1", "gone", MessageAuthor.Agent)))
        val held = cache.countHeldChars()

        documents.startPass()
        documents.read("s1", "kept", MessageAuthor.Agent, "Kept.", writing = false)
        documents.finishPass("s1", setOf(buildDocumentKey("s1", "kept", MessageAuthor.Agent)))

        assertEquals(held - "Gone.".length, cache.countHeldChars())
    }

    /**
     * Runs [documents]' passes over [texts] the way a view model does: one pass, one more as a
     * token would start, then one more each time a background parse finishes. Returns how many
     * background parses finished once the passes came to rest, or fails when they never do.
     */
    private fun TestScope.passUntilAtRest(documents: MessageDocuments, texts: Map<String, String>): Long {
        fun pass() {
            documents.startPass()
            for ((id, text) in texts) documents.read("s1", id, MessageAuthor.Agent, text, writing = false)
            documents.finishPass("s1", texts.keys.map { buildDocumentKey("s1", it, MessageAuthor.Agent) }.toSet())
        }
        pass()
        pass()
        repeat(20) {
            val before = documents.parsed.value
            runCurrent()
            if (documents.parsed.value == before) return before
            pass()
        }
        error("The passes never came to rest: ${documents.parsed.value} background parses")
    }

    @Test
    fun `comes to rest when the cache holds less than the messages, however often a pass runs`() = runTest(dispatcher) {
        val documents = open(DocumentCache(maxChars = 1))

        assertEquals(0L, passUntilAtRest(documents, mapOf("a" to "A", "b" to "B")))
    }

    @Test
    fun `comes to rest when one large message pushes every other one out of the cache`() = runTest(dispatcher) {
        val documents = open(DocumentCache(maxChars = 10))
        val texts = mapOf("large" to "L".repeat(50)) + (1..5).associate { "small$it" to "s$it" }

        assertEquals(0L, passUntilAtRest(documents, texts))
    }

    @Test
    fun `stops parsing and storing once its screen closes`() {
        val cache = DocumentCache()
        val scope = CoroutineScope(Job())
        val documents = MessageDocuments(cache, scope, Dispatchers.Default)
        // Large enough that each parse takes milliseconds, and that the first fills the pass's
        // budget, so the rest go to the worker.
        val texts = (1..4).associate { "m$it" to "Paragraph $it with **bold** text. ".repeat(12_000) }
        documents.startPass()
        texts.forEach { (id, text) -> documents.read("s1", id, MessageAuthor.Agent, text, writing = false) }
        documents.finishPass("s1", texts.keys.map { buildDocumentKey("s1", it, MessageAuthor.Agent) }.toSet())

        val deadline = System.nanoTime() + 10_000_000_000
        while (documents.parsed.value < 1L) check(System.nanoTime() < deadline) { "The first background parse never finished" }
        runBlocking { scope.coroutineContext.job.cancelAndJoin() }

        assertEquals(1L, documents.parsed.value)
        assertEquals(2, texts.count { (id, text) -> cache.read(buildDocumentKey("s1", id, MessageAuthor.Agent), text) != null })
    }

    @Test
    fun `holds at most the bound, dropping the entries used longest ago`() {
        val cache = DocumentCache(maxChars = 10)
        val key = { id: String -> DocumentKey("s1", id, breaks = false, embeddedHtml = true) }
        cache.store(key("a"), "aaaa", parseMarkdown("aaaa"))
        cache.store(key("b"), "bbbb", parseMarkdown("bbbb"))
        cache.read(key("a"), "aaaa")
        cache.store(key("c"), "cccc", parseMarkdown("cccc"))

        assertNotNull(cache.read(key("a"), "aaaa"))
        assertNull(cache.read(key("b"), "bbbb"))
        assertEquals(8, cache.countHeldChars())
    }
}
