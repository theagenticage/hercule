package dev.hercule.android.controller

import java.io.Closeable
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration
import kotlinx.coroutines.test.TestScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * A mock controller for the tests: it issues live socket tickets, accepts `/ws` sockets, and
 * answers every other request with [respondHttp].
 *
 * The tests run the app's coroutines on the test's virtual clock and never suspend the test
 * body: they run the scheduler by hand ([awaitValue]) while polling for what arrives on
 * OkHttp's threads. So virtual time moves only when a test advances it ([advanceTime]), and a
 * 30 s ping or a 10 s timeout fires exactly when the test says, never while it waits on real
 * network traffic.
 */
class MockController(
    private val respondHttp: (RecordedRequest) -> MockResponse = { MockResponse.Builder().code(404).build() },
) : Closeable {
    private val server = MockWebServer()
    private val ticketsIssued = AtomicInteger()

    /** When set, the ticket request fails with 401, as it does for a revoked API key. */
    val refuseTickets = AtomicBoolean(false)

    /** The sockets the app opened, in order, not yet taken by [awaitSocket]. */
    val sockets = LinkedBlockingQueue<ServerSocket>()

    /** The targets (path and query) of the HTTP requests [respondHttp] answered, in order. */
    val httpTargets = LinkedBlockingQueue<String>()

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/v1/auth/ws-ticket" -> if (refuseTickets.get()) {
                    MockResponse.Builder().code(401)
                        .body("""{"error":{"code":"unauthenticated","message":"the API key was revoked"}}""").build()
                } else {
                    MockResponse.Builder().body("""{"ticket":"ticket-${ticketsIssued.incrementAndGet()}"}""").build()
                }
                "/ws" -> MockResponse.Builder().webSocketUpgrade(ServerSocket().also(sockets::add)).build()
                else -> {
                    httpTargets += request.target
                    respondHttp(request)
                }
            }
        }
        server.start()
    }

    /** The controller's origin, as the app stores it. */
    val origin = server.url("/")

    /** Builds an API client signed in with an API key. */
    fun buildApi(): ControllerApi = ControllerApi(origin, "key-1", OkHttpClient())

    override fun close() = server.close()

    /** The server's side of one socket: the frames the app sent, in order. */
    class ServerSocket : WebSocketListener() {
        val frames = LinkedBlockingQueue<JsonObject>()
        val closed = AtomicBoolean(false)

        @Volatile
        lateinit var socket: WebSocket

        fun send(text: String) {
            socket.send(text)
        }

        override fun onOpen(webSocket: WebSocket, response: Response) {
            socket = webSocket
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            frames += Json.parseToJsonElement(text).jsonObject
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            closed.set(true)
            webSocket.close(code, null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = closed.set(true)
    }
}

/** Runs the scheduler until [poll] returns a value, waiting up to 5 s of real time. */
fun <T : Any> TestScope.awaitValue(poll: () -> T?): T {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
    while (true) {
        testScheduler.runCurrent()
        poll()?.let { return it }
        check(System.nanoTime() < deadline) { "Nothing arrived within 5 s." }
        Thread.sleep(2)
    }
}

/** Moves virtual time on by [duration] and runs what became due. */
fun TestScope.advanceTime(duration: Duration) {
    testScheduler.advanceTimeBy(duration)
    testScheduler.runCurrent()
}

fun TestScope.awaitSocket(controller: MockController): MockController.ServerSocket =
    awaitValue { controller.sockets.poll() }

fun TestScope.awaitFrame(socket: MockController.ServerSocket): JsonObject = awaitValue { socket.frames.poll() }

/** Waits for the next socket, checks that it says hello first, and accepts the hello. */
fun TestScope.acceptHello(controller: MockController): MockController.ServerSocket {
    val socket = awaitSocket(controller)
    check(awaitFrame(socket).readText("tag") == "hello") { "The first request was not hello." }
    socket.send("""{"_tag":"Exit","requestId":"0","exit":{"_tag":"Success","value":{"v":1,"serverVersion":"test"}}}""")
    return socket
}

/** Returns the string at [key], failing when there is none. */
fun JsonObject.readText(key: String): String = this[key]!!.jsonPrimitive.content
