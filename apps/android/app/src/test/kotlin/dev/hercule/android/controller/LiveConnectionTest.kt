package dev.hercule.android.controller

import java.util.Collections
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.seconds
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
        assertEquals(null, first.frames.poll())
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
}
