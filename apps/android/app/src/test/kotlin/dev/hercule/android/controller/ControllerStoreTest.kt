package dev.hercule.android.controller

import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.ConversationSenderRole
import dev.hercule.android.wire.Invalidate
import dev.hercule.android.wire.InvalidateKind
import kotlin.test.assertEquals
import kotlin.time.Instant
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Test

/** Tests what [ControllerStore] reads on each push, and how it merges what it reads. */
class ControllerStoreTest {
    private val controller = MockController(::respondHttp)

    @After
    fun stopController() = controller.close()

    private fun respondHttp(request: RecordedRequest): MockResponse {
        val url = request.url
        val body = when {
            url.encodedPath == "/api/v1/assistants" -> """{"items":[$ASSISTANT_JSON]}"""
            url.encodedPath == "/api/v1/sessions" && url.queryParameter("conversationId") == "c1" ->
                """{"items":[${buildSessionJson("s9", conversationId = "c1")}]}"""
            url.encodedPath == "/api/v1/sessions" -> """{"items":[${buildSessionJson("s1")}]}"""
            url.encodedPath == "/api/v1/sessions/s1/transcript" ->
                """{"items":[{"position":1,"at":"$AT","event":{"_tag":"turn.started","turnId":"t1"}}]}"""
            else -> """{"items":[]}"""
        }
        return MockResponse.Builder().body(body).build()
    }

    private fun TestScope.buildStore(): ControllerStore {
        val api = controller.buildApi()
        val live = LiveConnection(api, OkHttpClient(), backgroundScope, testScheduler.timeSource, random = { 0.0 })
        return ControllerStore(api, live, backgroundScope)
    }

    /** Takes [count] subscribe requests from [socket] and returns their request ids by topic. */
    private fun TestScope.awaitSubscriptions(socket: MockController.ServerSocket, count: Int): Map<String, String> =
        List(count) { awaitFrame(socket) }.associate { it["payload"]!!.jsonObject.readText("topic") to it.readText("id") }

    @Test
    fun `a session push for an assistant's conversation reads that assistant's session, not the threads`() = runTest {
        val store = buildStore()
        store.start()
        val socket = acceptHello(controller)
        val requestIds = awaitSubscriptions(socket, count = 3)
        socket.send(buildChunk(requestIds.getValue("assistant"), """{"_tag":"invalidate","ids":[],"kind":"updated"}"""))
        awaitValue { store.currentAssistantSessions.value["a1"] }
        socket.send(buildChunk(requestIds.getValue("session"), """{"_tag":"invalidate","ids":[],"kind":"updated","conversationIds":{}}"""))
        awaitValue { store.threadSessions.value }
        // Waits for the first push's last read, the assistant's session, before clearing.
        awaitValue { controller.httpTargets.toList().takeIf { targets -> targets.count { "conversationId" in it } == 2 } }
        controller.httpTargets.clear()

        socket.send(
            buildChunk(requestIds.getValue("session"), """{"_tag":"invalidate","ids":["s9"],"kind":"updated","conversationIds":{"s9":"c1"}}"""),
        )

        val target = awaitValue { controller.httpTargets.poll() }
        assertEquals("/api/v1/sessions", target.substringBefore('?'))
        assertEquals(true, "conversationId=c1" in target, target)
        assertEquals(listOf("s1"), store.threadSessions.value!!.map { it.id })
    }

    @Test
    fun `a thread's transcript streams a reply's tail until the row that holds its text lands`() = runTest {
        val store = buildStore()
        val transcripts = mutableListOf<ThreadTranscript?>()
        backgroundScope.launch { store.observeTranscript("s1").collect { transcripts += it } }
        store.start()
        val socket = acceptHello(controller)
        val requestIds = awaitSubscriptions(socket, count = 5)
        val stream = requestIds.getValue("session:s1:stream")
        val tap = requestIds.getValue("session:s1:tap")

        socket.send(buildChunk(tap, """{"_tag":"delta","items":[{"turnId":"t1","itemId":"a1","streamKind":"assistant_text","delta":"Hello"}]}"""))
        awaitValue { transcripts.lastOrNull()?.takeIf { it.tails.isNotEmpty() } }
        assertEquals(mapOf("a1" to "Hello"), transcripts.last()!!.tails)

        socket.send(
            buildChunk(
                stream,
                """{"_tag":"delta","cursor":"2","items":[{"position":2,"at":"$AT","event":
                    {"_tag":"content.delta","turnId":"t1","itemId":"a1","streamKind":"assistant_text","delta":"Hello"}}]}""",
            ),
        )

        val latest = awaitValue { transcripts.lastOrNull()?.takeIf { it.rows.size == 2 } }
        assertEquals(listOf(1L, 2L), latest.rows.map { it.position })
        assertEquals(emptyMap(), latest.tails)
    }

    private fun buildMessage(position: Long, text: String = "m$position") = ConversationMessage(
        id = "id$position",
        conversationId = "c1",
        containerKey = null,
        position = position,
        senderRole = ConversationSenderRole.Owner,
        senderLabel = "ada",
        text = text,
        sessionId = null,
        turnId = null,
        itemId = null,
        actor = "user",
        createdAt = Instant.parse(AT),
    )

    @Test
    fun `a merged invalidate that includes one naming nothing names nothing`() {
        val merged = mergeInvalidates(
            Invalidate(listOf("s1"), InvalidateKind.Created, mapOf("s1" to null)),
            Invalidate(emptyList(), InvalidateKind.Updated, emptyMap()),
        )

        assertEquals(emptyList(), merged.ids)
    }

    @Test
    fun `a merged invalidate names the ids and conversations of both`() {
        val merged = mergeInvalidates(
            Invalidate(listOf("s1"), InvalidateKind.Created, mapOf("s1" to null)),
            Invalidate(listOf("s2", "s1"), InvalidateKind.Updated, mapOf("s2" to "c1", "s1" to null)),
        )

        assertEquals(listOf("s1", "s2"), merged.ids)
        assertEquals(mapOf("s1" to null, "s2" to "c1"), merged.conversationIds)
    }

    @Test
    fun `merges the newest page into the held messages, oldest first, replacing a message by position`() {
        val held = listOf(buildMessage(1), buildMessage(2), buildMessage(3, "old"))

        val merged = mergeConversationMessages(held, listOf(buildMessage(4), buildMessage(3, "new")))

        assertEquals(listOf(1L, 2L, 3L, 4L), merged.map { it.position })
        assertEquals("new", merged[2].text)
    }

    @Test
    fun `drops the held messages when the newest page leaves a gap after them`() {
        val held = listOf(buildMessage(1), buildMessage(2))

        val merged = mergeConversationMessages(held, listOf(buildMessage(5), buildMessage(4)))

        assertEquals(listOf(4L, 5L), merged.map { it.position })
    }

    private companion object {
        const val AT = "2026-10-13T09:00:00Z"
        const val ASSISTANT_JSON = """{"id":"a1","name":"Ada","instanceId":"i1","permissionProfileId":"p1",
            "accessMode":"auto","model":null,"createdAt":"$AT","updatedAt":"$AT","reply":"turn-end",
            "mainConversationId":"c1"}"""

        fun buildChunk(requestId: String, value: String) = """{"_tag":"Chunk","requestId":"$requestId","values":[$value]}"""
    }
}
