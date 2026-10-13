package dev.hercule.android.controller

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.logging.Handler
import java.util.logging.LogRecord
import java.util.logging.Logger
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Test

/** Tests [LiveConnection] against a [MockController], on the test's virtual clock. */
class LiveConnectionTest {
    private val controller = MockController()

    @After
    fun stopController() = controller.close()

    // No jitter, so every wait is exactly its scheduled length.
    private fun TestScope.buildConnection() =
        LiveConnection(controller.buildApi(), OkHttpClient(), backgroundScope, testScheduler.timeSource, random = { 0.0 })

    @Test
    fun `sends hello first, with a fresh ticket and empty headers, then reports connected`() = runTest {
        val connection = buildConnection()
        connection.start()

        val socket = awaitSocket(controller)
        val hello = awaitFrame(socket)

        assertEquals(
            Json.parseToJsonElement(
                """{"_tag":"Request","id":"0","tag":"hello","payload":{"v":1,"ticket":"ticket-1"},"headers":[]}""",
            ),
            hello,
        )
        socket.send("""{"_tag":"Exit","requestId":"0","exit":{"_tag":"Success","value":{"v":1,"serverVersion":"test"}}}""")
        val state = awaitValue { connection.state.value as? LiveConnectionState.Connected }
        assertEquals(controller.origin.host, state.host)
    }

    @Test
    fun `passes every value of a chunk to the subscriber, then acknowledges the chunk once`() = runTest {
        val connection = buildConnection()
        val messages = Collections.synchronizedList(mutableListOf<LiveMessage>())
        backgroundScope.launch { connection.subscribe("session").toList(messages) }
        connection.start()
        val socket = acceptHello(controller)

        val subscribe = awaitFrame(socket)
        assertEquals("subscribe", subscribe.readText("tag"))
        assertEquals("session", subscribe["payload"]!!.jsonObject.readText("topic"))
        val requestId = subscribe.readText("id")
        socket.send(
            """{"_tag":"Chunk","requestId":"$requestId","values":[
                {"_tag":"invalidate","ids":[],"kind":"updated","conversationIds":{}},
                {"_tag":"invalidate","ids":["s1"],"kind":"created","conversationIds":{"s1":null}}]}""",
        )

        awaitValue { messages.takeIf { it.size == 2 } }
        assertEquals(listOf(emptyList(), listOf("s1")), messages.map { (it as LiveMessage.Invalidated).invalidate.ids })
        assertEquals(Json.parseToJsonElement("""{"_tag":"Ack","requestId":"$requestId"}"""), awaitFrame(socket))
    }

    @Test
    fun `pings every 30 s, and reconnects when a ping gets no reply within 10 s`() = runTest {
        val connection = buildConnection()
        connection.start()
        val first = acceptHello(controller)
        awaitValue { connection.state.value as? LiveConnectionState.Connected }

        advanceTime(29.seconds)
        // Frames arrive in the order they were sent, so if this subscribe is the next frame,
        // no ping went out in the first 29 s.
        backgroundScope.launch { connection.subscribe("runner").collect {} }
        assertEquals("subscribe", awaitFrame(first).readText("tag"))
        advanceTime(1.seconds)
        val ping = awaitFrame(first)
        assertEquals("ping", ping.readText("tag"))
        assertEquals("[]", ping["headers"].toString())

        advanceTime(10.seconds)
        awaitValue { connection.state.value as? LiveConnectionState.Reconnecting }
        awaitValue { first.closed.takeIf { it.get() } }

        // The first wait before reconnecting is 1 s, and the new connection asks for a new ticket.
        advanceTime(1.seconds)
        val second = awaitSocket(controller)
        assertEquals("ticket-2", awaitFrame(second)["payload"]!!.jsonObject.readText("ticket"))
    }

    @Test
    fun `subscribes again after a reconnect, resuming a log topic from its last cursor`() = runTest {
        val connection = buildConnection()
        val messages = Collections.synchronizedList(mutableListOf<LiveMessage>())
        backgroundScope.launch { connection.subscribe("session:s1:stream", cursor = "0").toList(messages) }
        connection.start()
        val first = acceptHello(controller)
        val subscribe = awaitFrame(first)
        assertEquals("0", subscribe["payload"]!!.jsonObject.readText("cursor"))
        first.send("""{"_tag":"Chunk","requestId":"${subscribe.readText("id")}","values":[{"_tag":"delta","cursor":"7","items":[]}]}""")
        awaitFrame(first) // The Ack.
        awaitValue { messages.takeIf { it.size == 1 } }

        first.socket.close(1001, "going away")
        awaitValue { connection.state.value as? LiveConnectionState.Reconnecting }
        advanceTime(1.seconds)
        val second = acceptHello(controller)

        val resubscribe = awaitFrame(second)
        assertEquals("subscribe", resubscribe.readText("tag"))
        assertEquals("session:s1:stream", resubscribe["payload"]!!.jsonObject.readText("topic"))
        assertEquals("7", resubscribe["payload"]!!.jsonObject.readText("cursor"))
    }

    @Test
    fun `tells a tap subscriber to reset when a connection starts, because earlier taps are lost`() = runTest {
        val connection = buildConnection()
        val messages = Collections.synchronizedList(mutableListOf<LiveMessage>())
        backgroundScope.launch { connection.subscribe("session:s1:tap").toList(messages) }
        connection.start()
        acceptHello(controller)

        awaitValue { messages.firstOrNull() }
        assertEquals(LiveMessage.Reset, messages.single())
    }

    @Test
    fun `stops with signed out when the controller refuses the ticket`() = runTest {
        controller.refuseTickets.set(true)
        val connection = buildConnection()

        connection.start()

        awaitValue { connection.state.value as? LiveConnectionState.SignedOut }
        assertEquals(0, controller.sockets.size)
    }

    @Test
    fun `skips a malformed value, passes the rest of its chunk on, and stays connected`() = runTest {
        val connection = buildConnection()
        val messages = Collections.synchronizedList(mutableListOf<LiveMessage>())
        backgroundScope.launch { connection.subscribe("session").toList(messages) }
        connection.start()
        val socket = acceptHello(controller)
        val requestId = awaitFrame(socket).readText("id")

        socket.send(
            """{"_tag":"Chunk","requestId":"$requestId","values":[
                {"_tag":"invalidate","ids":5},
                {"_tag":"invalidate","ids":["s1"],"kind":"created","conversationIds":{"s1":null}}]}""",
        )

        assertEquals(Json.parseToJsonElement("""{"_tag":"Ack","requestId":"$requestId"}"""), awaitFrame(socket))
        assertEquals(listOf("s1"), (messages.single() as LiveMessage.Invalidated).invalidate.ids)
        assertIs<LiveConnectionState.Connected>(connection.state.value)
    }

    @Test
    fun `logs only the type of a malformed value, never its content`() = runTest {
        val logged = Collections.synchronizedList(mutableListOf<String>())
        val handler = object : Handler() {
            override fun publish(record: LogRecord) {
                logged += listOfNotNull(record.message, record.thrown?.toString()).joinToString(" ")
            }

            override fun flush() = Unit

            override fun close() = Unit
        }
        val logger = Logger.getLogger(LiveConnection::class.java.name)
        logger.addHandler(handler)
        try {
            val connection = buildConnection()
            backgroundScope.launch { connection.subscribe("session").toList(mutableListOf()) }
            connection.start()
            val socket = acceptHello(controller)
            val requestId = awaitFrame(socket).readText("id")

            socket.send("""{"_tag":"Chunk","requestId":"$requestId","values":[{"_tag":"invalidate","ids":"the user's secret transcript"}]}""")

            awaitFrame(socket)
            val line = logged.single()
            assertTrue("invalidate" in line, line)
            assertFalse("secret" in line, line)
        } finally {
            logger.removeHandler(handler)
        }
    }

    @Test
    fun `acknowledges a chunk only after the collector has taken its messages`() = runTest {
        val connection = buildConnection()
        val messages = Collections.synchronizedList(mutableListOf<LiveMessage>())
        val consumed = CompletableDeferred<Unit>()
        backgroundScope.launch {
            connection.subscribe("session").collect {
                messages += it
                consumed.await()
            }
        }
        connection.start()
        val socket = acceptHello(controller)
        val requestId = awaitFrame(socket).readText("id")
        socket.send("""{"_tag":"Chunk","requestId":"$requestId","values":[{"_tag":"invalidate","ids":[],"kind":"updated","conversationIds":{}}]}""")
        awaitValue { messages.firstOrNull() }

        // The collector is still busy with the message. Frames arrive in order, so a subscribe
        // sent now being the next frame shows that no Ack went out before it.
        backgroundScope.launch { connection.subscribe("runner").collect {} }
        assertEquals("subscribe", awaitFrame(socket).readText("tag"))

        consumed.complete(Unit)
        assertEquals(Json.parseToJsonElement("""{"_tag":"Ack","requestId":"$requestId"}"""), awaitFrame(socket))
    }

    @Test
    fun `stops reconnecting with signed out when a subscription fails as unauthenticated`() = runTest {
        val connection = buildConnection()
        backgroundScope.launch { connection.subscribe("session").collect {} }
        connection.start()
        val socket = acceptHello(controller)
        val requestId = awaitFrame(socket).readText("id")

        controller.refuseTickets.set(true)
        socket.send(buildFailure(requestId, "unauthenticated"))
        awaitValue { connection.state.value as? LiveConnectionState.Reconnecting }
        advanceTime(1.seconds)

        awaitValue { connection.state.value as? LiveConnectionState.SignedOut }
        assertEquals(0, controller.sockets.size)
    }

    @Test
    fun `ends the flow when an append-only topic does not exist`() = runTest {
        val connection = buildConnection()
        val collection = backgroundScope.launch { connection.subscribe("session:s9:stream").collect {} }
        connection.start()
        val socket = acceptHello(controller)
        val requestId = awaitFrame(socket).readText("id")

        socket.send(buildFailure(requestId, "not_found"))

        awaitValue { collection.takeIf { it.isCompleted } }
        assertFalse(collection.isCancelled)
    }

    @Test
    fun `starts a log topic again from the head when the controller rejects its cursor`() = runTest {
        val connection = buildConnection()
        val messages = Collections.synchronizedList(mutableListOf<LiveMessage>())
        backgroundScope.launch { connection.subscribe("session:s1:stream", cursor = "4").toList(messages) }
        connection.start()
        val socket = acceptHello(controller)
        val requestId = awaitFrame(socket).readText("id")

        socket.send(buildFailure(requestId, "validation"))

        val resubscribe = awaitFrame(socket)
        assertEquals("subscribe", resubscribe.readText("tag"))
        assertEquals(null, resubscribe["payload"]!!.jsonObject["cursor"])
        awaitValue { messages.firstOrNull() }
        assertEquals(LiveMessage.Reset, messages.single())
    }

    @Test
    fun `retries a subscription the controller ended with cap_exceeded after 1 s, then 2 s`() = runTest {
        val connection = buildConnection()
        backgroundScope.launch { connection.subscribe("runner").collect {} }
        backgroundScope.launch { connection.subscribe("session").collect {} }
        connection.start()
        val socket = acceptHello(controller)
        val subscribes = listOf(awaitFrame(socket), awaitFrame(socket))
            .associate { it["payload"]!!.jsonObject.readText("topic") to it.readText("id") }
        val markerId = subscribes.getValue("runner")

        // An empty chunk on the marker subscription is acknowledged at once. Frames arrive in
        // order, so its Ack shows that every earlier frame was handled, and that nothing else
        // was sent in between.
        fun awaitMarker() {
            socket.send("""{"_tag":"Chunk","requestId":"$markerId","values":[]}""")
            assertEquals(Json.parseToJsonElement("""{"_tag":"Ack","requestId":"$markerId"}"""), awaitFrame(socket))
        }

        var sessionId = subscribes.getValue("session")
        for (wait in listOf(1.seconds, 2.seconds)) {
            socket.send(buildFailure(sessionId, "cap_exceeded"))
            awaitMarker()
            advanceTime(wait - 1.milliseconds)
            awaitMarker()
            advanceTime(1.milliseconds)
            val retry = awaitFrame(socket)
            assertEquals("session", retry["payload"]!!.jsonObject.readText("topic"))
            sessionId = retry.readText("id")
        }
    }

    @Test
    fun `interrupts the subscribe request when the collector stops`() = runTest {
        val connection = buildConnection()
        val collection = backgroundScope.launch { connection.subscribe("session").collect {} }
        connection.start()
        val socket = acceptHello(controller)
        val requestId = awaitFrame(socket).readText("id")

        collection.cancel()

        assertEquals(Json.parseToJsonElement("""{"_tag":"Interrupt","requestId":"$requestId"}"""), awaitFrame(socket))
    }

    @Test
    fun `stop closes the socket with code 1000`() = runTest {
        val connection = buildConnection()
        connection.start()
        val socket = acceptHello(controller)
        awaitValue { connection.state.value as? LiveConnectionState.Connected }

        connection.stop()

        awaitValue { socket.closed.takeIf { it.get() } }
        assertEquals(1000, socket.closeCode.get())
        assertEquals(LiveConnectionState.Stopped, connection.state.value)
    }

    @Test
    fun `ignores what the previous socket reports after a reconnect`() = runTest {
        val connection = buildConnection()
        connection.start()
        val first = acceptHello(controller)
        awaitValue { connection.state.value as? LiveConnectionState.Connected }

        // A Defect ends the connection, which cancels the first socket. OkHttp then reports the
        // cancelled socket's failure, and that report waits in the event queue until the next
        // connection reads it.
        first.send("""{"_tag":"Defect","defect":"bad frame"}""")
        awaitValue { connection.state.value as? LiveConnectionState.Reconnecting }
        advanceTime(1.seconds)
        val second = acceptHello(controller)
        awaitValue { connection.state.value as? LiveConnectionState.Connected }

        advanceTime(30.seconds)
        assertEquals("ping", awaitFrame(second).readText("tag"))
        assertIs<LiveConnectionState.Connected>(connection.state.value)
    }

    @Test
    fun `gives up on a hello with no reply after 10 s and connects again with a new ticket`() = runTest {
        val connection = buildConnection()
        connection.start()
        val first = awaitSocket(controller)
        assertEquals("hello", awaitFrame(first).readText("tag"))

        advanceTime(10.seconds)
        awaitValue { first.closed.takeIf { it.get() } }
        assertEquals(LiveConnectionState.Connecting, connection.state.value)

        advanceTime(1.seconds)
        val second = awaitSocket(controller)
        assertEquals("ticket-2", awaitFrame(second)["payload"]!!.jsonObject.readText("ticket"))
    }

    @Test
    fun `stays stopped when stop runs while the connection is reporting connected`() = runTest {
        // The connection runs on real threads here, so stop() can run while the event loop is
        // in the middle of the hello reply. The clock blocks at that moment until released.
        val atHelloReply = CountDownLatch(1)
        val release = CountDownLatch(1)
        val clock = object : TimeSource {
            override fun markNow(): TimeMark {
                atHelloReply.countDown()
                release.await(5, TimeUnit.SECONDS)
                return TimeSource.Monotonic.markNow()
            }
        }
        val scope = CoroutineScope(Dispatchers.Default + Job())
        try {
            val connection = LiveConnection(controller.buildApi(), OkHttpClient(), scope, clock, random = { 0.0 })
            connection.start()
            val socket = acceptHello(controller)
            check(atHelloReply.await(5, TimeUnit.SECONDS)) { "The hello reply was never handled." }

            connection.stop()
            release.countDown()

            awaitValue { socket.closed.takeIf { it.get() } }
            assertEquals(LiveConnectionState.Stopped, connection.state.value)
        } finally {
            scope.cancel()
        }
    }

    /** Builds an `Exit` frame that fails [requestId] with the API error [code]. */
    private fun buildFailure(requestId: String, code: String) =
        """{"_tag":"Exit","requestId":"$requestId","exit":{"_tag":"Failure","cause":[
            {"_tag":"Fail","error":{"error":{"code":"$code","message":"refused"}}}]}}"""
}
