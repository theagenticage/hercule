package dev.hercule.android.ui.assistant

import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.controller.LiveConnection
import dev.hercule.android.controller.MockController
import dev.hercule.android.controller.acceptHello
import dev.hercule.android.controller.awaitFrame
import dev.hercule.android.controller.awaitValue
import dev.hercule.android.controller.buildSessionJson
import dev.hercule.android.controller.readText
import kotlin.test.assertEquals
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
 * Tests [observeAssistantState] against a mock controller: the answer so far follows the
 * running turn of the assistant's session as it streams, and is cleared once the reply is
 * stored in the Conversation.
 */
class AssistantViewModelTest {
    private val controller = MockController(::respondHttp)

    // The messages of conversation c1. A test adds the stored reply to it.
    @Volatile
    private var messagesJson = OWNER_MESSAGE_JSON

    @After
    fun stopController() = controller.close()

    private fun respondHttp(request: RecordedRequest): MockResponse {
        val url = request.url
        val body = when (url.encodedPath) {
            "/api/v1/assistants" -> """{"items":[$ASSISTANT_JSON]}"""
            "/api/v1/sessions" -> if (url.queryParameter("conversationId") == "c1") {
                """{"items":[${buildSessionJson("s9", conversationId = "c1").replace("\"idle\"", "\"busy\"")}]}"""
            } else {
                """{"items":[]}"""
            }
            "/api/v1/sessions/s9/transcript" ->
                """{"items":[{"position":1,"at":"$AT","event":{"_tag":"turn.started","turnId":"t1"}}]}"""
            "/api/v1/conversations/c1/messages" -> """{"items":[$messagesJson]}"""
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
            // Other frames, such as the one that ends a subscription, carry no topic.
            val topic = frame["payload"]?.jsonObject?.get("topic") ?: continue
            requestIds[topic.jsonPrimitive.content] = frame.readText("id")
        }
        return requestIds
    }

    @Test
    fun `the answer so far streams from the running turn and is cleared when the reply is stored`() = runTest {
        val store = buildStore()
        val states = mutableListOf<AssistantUiState?>()
        backgroundScope.launch { observeAssistantState(store, "a1").collect { states += it } }
        store.start()
        val socket = acceptHello(controller)
        // The first push of each list's topic triggers the first read of that list.
        awaitSubscriptions(socket, setOf("session", "assistant", "runner")).values.forEach { socket.send(buildChunk(it, NOTHING_CHANGED)) }
        val requestIds = awaitSubscriptions(socket, setOf("conversation", "session:s9:stream", "session:s9:tap"))
        socket.send(buildChunk(requestIds.getValue("conversation"), NOTHING_CHANGED))
        val stream = requestIds.getValue("session:s9:stream")
        awaitValue { states.lastOrNull()?.takeIf { it.answering } }
        assertEquals(null, states.last()!!.answerSoFar)

        socket.send(buildChunk(stream, buildRowsDelta(2, """{"_tag":"item.started","turnId":"t1","itemId":"a1","kind":"assistant_message"}""")))
        socket.send(
            buildChunk(
                requestIds.getValue("session:s9:tap"),
                """{"_tag":"delta","items":[{"turnId":"t1","itemId":"a1","streamKind":"assistant_text","delta":"Hello"}]}""",
            ),
        )
        assertEquals("Hello", awaitValue { states.lastOrNull()?.answerSoFar })

        // The row that holds the words replaces the tail, so the text stays the same.
        socket.send(
            buildChunk(
                stream,
                buildRowsDelta(3, """{"_tag":"content.delta","turnId":"t1","itemId":"a1","streamKind":"assistant_text","delta":"Hello"}"""),
            ),
        )
        socket.send(buildChunk(stream, buildRowsDelta(4, """{"_tag":"item.completed","turnId":"t1","itemId":"a1","kind":"assistant_message","status":"completed"}""")))
        awaitValue { store.observeRunningTurn("s9").value?.rows?.takeIf { it.size == 4 } }
        assertEquals("Hello", states.last()!!.answerSoFar)

        messagesJson = "$OWNER_MESSAGE_JSON,$REPLY_JSON"
        socket.send(buildChunk(requestIds.getValue("conversation"), """{"_tag":"invalidate","ids":["c1"],"kind":"updated"}"""))

        awaitValue { states.lastOrNull()?.takeIf { it.messages.size == 2 } }
        assertEquals(null, states.last()!!.answerSoFar)
    }

    private companion object {
        const val AT = "2026-10-13T09:00:00Z"
        const val ASSISTANT_JSON = """{"id":"a1","name":"Ada","instanceId":"i1","permissionProfileId":"p1",
            "accessMode":"auto","model":null,"createdAt":"$AT","updatedAt":"$AT","reply":"turn-end",
            "mainConversationId":"c1"}"""
        const val OWNER_MESSAGE_JSON = """{"id":"m1","conversationId":"c1","containerKey":null,"position":1,
            "senderRole":"owner","senderLabel":"You","text":"Say hello","sessionId":null,"turnId":null,
            "itemId":null,"actor":"user","createdAt":"$AT"}"""
        const val REPLY_JSON = """{"id":"m2","conversationId":"c1","containerKey":null,"position":2,
            "senderRole":"assistant","senderLabel":"Ada","text":"Hello","sessionId":"s9","turnId":"t1",
            "itemId":"a1","actor":"session:s9","createdAt":"$AT"}"""
        const val NOTHING_CHANGED = """{"_tag":"invalidate","ids":[],"kind":"updated","conversationIds":{}}"""

        fun buildChunk(requestId: String, value: String) = """{"_tag":"Chunk","requestId":"$requestId","values":[$value]}"""

        /** Builds a stream delta that holds one transcript row: [event] at [position]. */
        fun buildRowsDelta(position: Long, event: String) =
            """{"_tag":"delta","cursor":"$position","items":[{"position":$position,"at":"$AT","event":$event}]}"""
    }
}
