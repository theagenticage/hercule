package dev.hercule.android.ui.thread

import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.controller.LiveConnection
import dev.hercule.android.controller.MockController
import dev.hercule.android.controller.acceptHello
import dev.hercule.android.controller.awaitFrame
import dev.hercule.android.controller.awaitValue
import dev.hercule.android.controller.buildSessionJson
import dev.hercule.android.controller.readText
import dev.hercule.android.markdown.parseMarkdown
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Test

/**
 * Tests [observeThreadState] against a mock controller: the bar shows before the transcript is
 * read, and a streamed reply reaches the state token by token, each state drawing one revision
 * of the text, already parsed.
 */
class ThreadViewModelTest {
    private val controller = MockController(::respondHttp)

    // Holds the transcript's read back until a test lets it through.
    private val transcriptReleased = CountDownLatch(1)

    @After
    fun stopController() = controller.close()

    private fun respondHttp(request: RecordedRequest): MockResponse {
        val url = request.url
        val body = when (url.encodedPath) {
            "/api/v1/sessions" -> if (url.queryParameter("thread") == "true") """{"items":[${buildSessionJson("s1")}]}""" else """{"items":[]}"""
            "/api/v1/sessions/s1/transcript" -> {
                transcriptReleased.await(5, TimeUnit.SECONDS)
                """{"items":[{"position":1,"at":"$AT","event":{"_tag":"turn.started","turnId":"t1"}}]}"""
            }
            else -> """{"items":[]}"""
        }
        return MockResponse.Builder().body(body).build()
    }

    private fun TestScope.buildStore(): ControllerStore {
        val api = controller.buildApi()
        val live = LiveConnection(api, OkHttpClient(), backgroundScope, testScheduler.timeSource, random = { 0.0 })
        return ControllerStore(api, live, backgroundScope)
    }

    /** Takes subscribe requests from [socket] until every topic in [topics] has one, and returns their request ids by topic. */
    private fun TestScope.awaitSubscriptions(socket: MockController.ServerSocket, topics: Set<String>): Map<String, String> {
        val requestIds = mutableMapOf<String, String>()
        while (!requestIds.keys.containsAll(topics)) {
            val frame = awaitFrame(socket)
            val topic = frame["payload"]?.jsonObject?.get("topic") ?: continue
            requestIds[topic.jsonPrimitive.content] = frame.readText("id")
        }
        return requestIds
    }

    @Test
    fun `draws the bar before the transcript is read, then streams a reply already parsed, one revision a state`() = runTest {
        val store = buildStore()
        val states = CopyOnWriteArrayList<ThreadUiState?>()
        backgroundScope.launch { observeThreadState(store, "s1", flowOf(emptySet())).collect { states += it } }
        store.start()
        val socket = acceptHello(controller)
        awaitSubscriptions(socket, setOf("session", "assistant", "runner")).values.forEach { socket.send(buildChunk(it, NOTHING_CHANGED)) }

        val bar = awaitValue { states.lastOrNull() }
        assertEquals("Thread s1", bar.title)
        assertEquals(emptyList(), bar.blocks)

        transcriptReleased.countDown()
        val requestIds = awaitSubscriptions(socket, setOf("session:s1:stream", "session:s1:tap"))
        val tap = requestIds.getValue("session:s1:tap")
        // The message starts after the tap is followed, so none of its tokens is missed.
        socket.send(
            buildChunk(
                requestIds.getValue("session:s1:stream"),
                """{"_tag":"delta","cursor":"2","items":[{"position":2,"at":"$AT","event":{"_tag":"item.started","turnId":"t1","itemId":"m1","kind":"assistant_message"}}]}""",
            ),
        )
        awaitValue { states.lastOrNull()?.blocks?.lastOrNull() as? AgentBlock }
        val reply = "First paragraph with **bold**.\n\nSecond paragraph, still being written"
        for (token in reply.chunked(6)) {
            socket.send(buildChunk(tap, """{"_tag":"delta","items":[{"turnId":"t1","itemId":"m1","streamKind":"assistant_text","delta":"${token.replace("\n", "\\n")}"}]}"""))
        }

        val last = awaitValue { states.lastOrNull()?.takeIf { (it.blocks.lastOrNull() as? AgentBlock)?.text == reply && it.documents["m1"]?.document == parseMarkdown("First paragraph with **bold**.\n\n") } }
        for (state in states.filterNotNull()) {
            val block = state.blocks.lastOrNull() as? AgentBlock ?: continue
            val parsed = state.documents[block.key] ?: continue
            val open = parsed.open.orEmpty()
            assertTrue(block.text.endsWith(open), "Each state draws the end of its own text as plain text")
            assertEquals(parseMarkdown(block.text.dropLast(open.length)), parsed.document, "and the start of that same text as markdown")
        }
        assertEquals("Second paragraph, still being written", last.documents["m1"]?.open)
    }

    private companion object {
        const val AT = "2026-10-13T09:00:00Z"
        const val NOTHING_CHANGED = """{"_tag":"invalidate","ids":[],"kind":"updated","conversationIds":{}}"""

        fun buildChunk(requestId: String, value: String) = """{"_tag":"Chunk","requestId":"$requestId","values":[$value]}"""
    }
}
