package dev.hercule.android.controller

import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.ConversationSenderRole
import dev.hercule.android.wire.Invalidate
import dev.hercule.android.wire.InvalidateKind
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertNotSame
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Test

/** Tests what [ControllerStore] reads on each push, and how it merges what it reads. */
class ControllerStoreTest {
    private val controller = MockController(::respondHttp)

    // The assistants the controller lists. A test changes it to delete the assistant.
    @Volatile
    private var assistantsJson = ASSISTANT_JSON

    // Replies to the next reads of conversation c1's current session, in order, each run on the
    // mock controller's thread so it can block. The default reply is session s9.
    private val c1SessionReplies = LinkedBlockingQueue<() -> String>()

    // How many times session s1's transcript was read.
    private val s1TranscriptReads = AtomicInteger()

    @After
    fun stopController() = controller.close()

    private fun respondHttp(request: RecordedRequest): MockResponse {
        val url = request.url
        when (url.encodedPath) {
            "/api/v1/sessions/s-gone" ->
                return MockResponse.Builder().code(404).body("""{"error":{"code":"not_found","message":"No such session."}}""").build()
            "/api/v1/sessions/s-broken" ->
                return MockResponse.Builder().code(500).body("""{"error":{"code":"internal","message":"The controller failed."}}""").build()
        }
        val body = when {
            url.encodedPath == "/api/v1/sessions/s7" -> buildSessionJson("s7")
            url.encodedPath == "/api/v1/sessions/s8" -> buildSessionJson("s8")
            url.encodedPath == "/api/v1/assistants" -> """{"items":[$assistantsJson]}"""
            url.encodedPath == "/api/v1/sessions" && url.queryParameter("conversationId") == "c1" ->
                c1SessionReplies.poll()?.invoke() ?: buildSessionPage("s9")
            url.encodedPath == "/api/v1/sessions" -> """{"items":[${buildSessionJson("s1")}]}"""
            url.encodedPath == "/api/v1/sessions/s1/transcript" -> {
                s1TranscriptReads.incrementAndGet()
                """{"items":[{"position":1,"at":"$AT","event":{"_tag":"turn.started","turnId":"t1"}}]}"""
            }
            else -> """{"items":[]}"""
        }
        return MockResponse.Builder().body(body).build()
    }

    private fun TestScope.buildStore(api: ControllerApi = controller.buildApi()): ControllerStore {
        val live = LiveConnection(api, OkHttpClient(), backgroundScope, testScheduler.timeSource, random = { 0.0 })
        return ControllerStore(api, live, backgroundScope)
    }

    /** Takes [count] subscribe requests from [socket] and returns their request ids by topic. */
    private fun TestScope.awaitSubscriptions(socket: MockController.ServerSocket, count: Int): Map<String, String> =
        List(count) { awaitFrame(socket) }.associate { it["payload"]!!.jsonObject.readText("topic") to it.readText("id") }

    @Test
    fun `a sender's session is read once, however often it is asked for`() = runTest {
        val store = buildStore(buildSerialApi())
        store.readSenderSession("s7")
        store.readSenderSession("s7")
        awaitValue { store.senderSessions.value["s7"] }
        store.readSenderSession("s7")
        awaitReadOfS8(store)

        assertEquals(listOf("/api/v1/sessions/s7", "/api/v1/sessions/s8"), controller.httpTargets.toList())
    }

    @Test
    fun `a sender's session that cannot be read is held as null and not read again`() = runTest {
        val store = buildStore(buildSerialApi())
        store.readSenderSession("s-gone")
        store.readSenderSession("s-broken")
        awaitValue { store.senderSessions.value.takeIf { "s-gone" in it && "s-broken" in it } }
        store.readSenderSession("s-gone")
        store.readSenderSession("s-broken")
        awaitReadOfS8(store)

        assertEquals(null, store.senderSessions.value["s-gone"])
        assertEquals(null, store.senderSessions.value["s-broken"])
        assertEquals(listOf("/api/v1/sessions/s-broken", "/api/v1/sessions/s-gone", "/api/v1/sessions/s8"), controller.httpTargets.toList().sorted())
    }

    /**
     * Returns an API that sends one request at a time, in the order they were made, so that a
     * request made before another reaches the controller first.
     */
    private fun buildSerialApi(): ControllerApi =
        controller.buildApi(OkHttpClient.Builder().dispatcher(Dispatcher().apply { maxRequests = 1 }).build())

    /**
     * Reads sender s8 and waits for its answer. With [buildSerialApi], a read asked for before it
     * would have reached the controller by then, so a test can check that no such read was made.
     */
    private fun TestScope.awaitReadOfS8(store: ControllerStore) {
        store.readSenderSession("s8")
        awaitValue { store.senderSessions.value["s8"] }
    }

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
    fun `a slow read of an assistant's session never overwrites a newer one`() = runTest {
        val release = CountDownLatch(1)
        c1SessionReplies += {
            release.await(5, TimeUnit.SECONDS)
            buildSessionPage("s-old")
        }
        c1SessionReplies += { buildSessionPage("s-new") }
        val store = buildStore()
        store.start()
        val socket = acceptHello(controller)
        val requestIds = awaitSubscriptions(socket, count = 3)

        // The assistants push starts the first read of c1's session, which the controller holds.
        socket.send(buildChunk(requestIds.getValue("assistant"), NOTHING_CHANGED))
        awaitValue { controller.httpTargets.firstOrNull { "conversationId=c1" in it } }
        // A session push reads c1's session again, and this second read answers first.
        socket.send(buildChunk(requestIds.getValue("session"), S9_IN_C1_CHANGED))
        awaitValue { store.currentAssistantSessions.value["a1"]?.takeIf { it.id == "s-new" } }

        release.countDown()
        // The store handles one assistants push at a time, so the list is read again only
        // after the held read has answered and been handled.
        socket.send(buildChunk(requestIds.getValue("assistant"), NOTHING_CHANGED))
        awaitValue { controller.httpTargets.count { it.startsWith("/api/v1/assistants") }.takeIf { it == 2 } }

        assertEquals("s-new", store.currentAssistantSessions.value["a1"]?.id)
    }

    @Test
    fun `a read that answers after its assistant was deleted does not bring the assistant back`() = runTest {
        val store = buildStore()
        store.start()
        val socket = acceptHello(controller)
        val requestIds = awaitSubscriptions(socket, count = 3)
        socket.send(buildChunk(requestIds.getValue("assistant"), NOTHING_CHANGED))
        awaitValue { store.currentAssistantSessions.value["a1"] }

        val release = CountDownLatch(1)
        c1SessionReplies += {
            release.await(5, TimeUnit.SECONDS)
            buildSessionPage("s9")
        }
        socket.send(buildChunk(requestIds.getValue("session"), S9_IN_C1_CHANGED))
        awaitValue { controller.httpTargets.count { "conversationId=c1" in it }.takeIf { it == 2 } }
        assistantsJson = ""
        socket.send(buildChunk(requestIds.getValue("assistant"), NOTHING_CHANGED))
        awaitValue { store.assistants.value?.takeIf { it.isEmpty() } }

        release.countDown()
        // The store handles one session push at a time, so this push reads the threads only
        // after the held read has answered and been handled.
        socket.send(buildChunk(requestIds.getValue("session"), NOTHING_CHANGED))
        awaitValue { controller.httpTargets.firstOrNull { it.startsWith("/api/v1/sessions") && "conversationId" !in it } }

        assertEquals(emptyMap(), store.currentAssistantSessions.value)
    }

    @Test
    fun `a session push with an id missing from its conversations reads every assistant's session`() = runTest {
        val store = buildStore()
        store.start()
        val socket = acceptHello(controller)
        val requestIds = awaitSubscriptions(socket, count = 3)
        socket.send(buildChunk(requestIds.getValue("assistant"), NOTHING_CHANGED))
        awaitValue { store.currentAssistantSessions.value["a1"] }

        // s7 is not in conversationIds, so its conversation is unknown and could be c1.
        socket.send(
            buildChunk(requestIds.getValue("session"), """{"_tag":"invalidate","ids":["s7"],"kind":"updated","conversationIds":{}}"""),
        )

        val target = awaitValue { controller.httpTargets.filter { "conversationId=c1" in it }.getOrNull(1) }
        assertEquals("/api/v1/sessions", target.substringBefore('?'))
    }

    @Test
    fun `forgets a transcript nobody has collected for 5 s, so the next call starts afresh`() = runTest {
        val store = buildStore()
        val first = store.observeTranscript("s1")
        val collection = backgroundScope.launch { first.collect {} }
        awaitValue { first.value }

        collection.cancel()
        advanceTime(5.seconds)

        assertNotSame(first, store.observeTranscript("s1"))
    }

    @Test
    fun `a forgotten transcript stays stopped, so a late collector of it reads nothing again`() = runTest {
        val store = buildStore()
        val first = store.observeTranscript("s1")
        val collection = backgroundScope.launch { first.collect {} }
        awaitValue { first.value }
        collection.cancel()
        advanceTime(5.seconds)

        val late = backgroundScope.launch { first.collect {} }
        // A read would reach the mock controller on its own thread, so give it real time to.
        repeat(50) {
            testScheduler.runCurrent()
            Thread.sleep(10)
        }
        late.cancel()

        assertEquals(1, s1TranscriptReads.get())
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

        const val NOTHING_CHANGED = """{"_tag":"invalidate","ids":[],"kind":"updated","conversationIds":{}}"""
        const val S9_IN_C1_CHANGED = """{"_tag":"invalidate","ids":["s9"],"kind":"updated","conversationIds":{"s9":"c1"}}"""

        fun buildChunk(requestId: String, value: String) = """{"_tag":"Chunk","requestId":"$requestId","values":[$value]}"""

        /** Builds a page of conversation c1's sessions that holds only the session [id]. */
        fun buildSessionPage(id: String) = """{"items":[${buildSessionJson(id, conversationId = "c1")}]}"""
    }
}
