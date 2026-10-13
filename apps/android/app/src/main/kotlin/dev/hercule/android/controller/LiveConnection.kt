package dev.hercule.android.controller

import dev.hercule.android.wire.ApiErrorCode
import dev.hercule.android.wire.ApiErrorEnvelope
import dev.hercule.android.wire.Delta
import dev.hercule.android.wire.Invalidate
import dev.hercule.android.wire.LiveHello
import dev.hercule.android.wire.LiveSubscribe
import dev.hercule.android.wire.WireJson
import java.io.IOException
import java.util.logging.Level
import java.util.logging.Logger
import kotlin.coroutines.cancellation.CancellationException
import kotlin.random.Random
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** One message of a live subscription, as [LiveConnection.subscribe] emits it. */
sealed interface LiveMessage {
    /** Records of a mutable topic changed. Read them again over HTTP. */
    data class Invalidated(val invalidate: Invalidate) : LiveMessage

    /** New items of an append-only topic, decoded by the topic they came on. */
    data class Appended(val delta: Delta) : LiveMessage

    /**
     * Items of an append-only topic were lost, so what the subscriber holds may have a gap.
     * Sent before a tap topic, or a log topic whose cursor the controller rejected, starts
     * again from the head. A tap subscriber skips the items it may have missed; a log
     * subscriber reads its records again over HTTP.
     */
    data object Reset : LiveMessage
}

/** Where the live connection stands, for the app's status line and its notification. */
sealed interface LiveConnectionState {
    /** [LiveConnection.start] has not been called, or [LiveConnection.stop] has. */
    data object Stopped : LiveConnectionState

    /** The first connection is being made. */
    data object Connecting : LiveConnectionState

    /** The controller at [host] accepted the connection's `hello`. */
    data class Connected(val host: String) : LiveConnectionState

    /** A connection that worked before dropped, and a new one is being made. */
    data object Reconnecting : LiveConnectionState

    /**
     * The controller refused the API key when asked for a ticket, so the key was revoked or
     * deleted. The connection stops trying; only signing in again helps.
     */
    data object SignedOut : LiveConnectionState
}

/**
 * Keeps one live socket (`/ws`) open to the controller and carries every subscription the app
 * holds over it.
 *
 * - Each connection fetches a new ticket with `auth.wsTicket` and sends it in `hello`.
 * - A drop is retried after a wait that starts at 1 s and doubles up to 30 s. A connection
 *   that stayed up for 30 s resets the wait to 1 s.
 * - The `ping` request goes out every 30 s. A ping that gets no reply within 10 s means the
 *   socket is dead, and a new connection is made.
 * - Every subscription is made again on each new connection. A log topic resumes from the
 *   last cursor it received; a mutable topic's first message says every record may have
 *   changed; a tap subscriber gets [LiveMessage.Reset].
 *
 * The rules are the ones `packages/client-core/src/live/live.ts` follows, so the app and the
 * web app recover the same way.
 *
 * Everything the connection holds is touched only by one coroutine, which handles the events
 * in [events] one at a time: frames from the socket, subscribes and unsubscribes from
 * collectors, and the timers. That coroutine is the only place that sends frames. The one
 * exception is [state], which [stop] also writes, so every write to it holds `stateLock`.
 */
class LiveConnection(
    private val api: ControllerApi,
    private val httpClient: OkHttpClient,
    private val scope: CoroutineScope,
    private val timeSource: TimeSource = TimeSource.Monotonic,
    private val random: () -> Double = { Random.nextDouble() },
) {
    private val mutableState = MutableStateFlow<LiveConnectionState>(LiveConnectionState.Stopped)

    /** Where the connection stands. */
    val state: StateFlow<LiveConnectionState> = mutableState.asStateFlow()

    private val events = Channel<Event>(Channel.UNLIMITED)

    // Every subscription a collector holds, kept across connections.
    private val subscriptions = LinkedHashSet<Subscription>()

    // Guards [supervisor] and every write to [mutableState].
    private val stateLock = Any()

    private var supervisor: Job? = null

    /** Starts connecting, unless the connection is already running. */
    fun start(): Unit = synchronized(stateLock) {
        if (supervisor?.isActive == true) return
        supervisor = scope.launch { superviseConnection() }
    }

    /**
     * Closes the socket with code 1000 and stops reconnecting. Subscriptions stay registered,
     * and are made again if [start] is called later.
     */
    fun stop(): Unit = synchronized(stateLock) {
        supervisor?.cancel()
        supervisor = null
        mutableState.value = LiveConnectionState.Stopped
    }

    /**
     * Sets [state] to [newState], unless [owner], the supervisor that wants to write it, was
     * cancelled. Without this check, a supervisor still finishing an event after [stop] could
     * overwrite [LiveConnectionState.Stopped] with an older state.
     */
    private fun publishState(owner: Job, newState: LiveConnectionState): Unit = synchronized(stateLock) {
        if (owner.isActive) mutableState.value = newState
    }

    /**
     * Subscribes to [topic] and returns its messages. The subscription lasts while the flow is
     * collected and survives reconnects; cancelling the collection unsubscribes.
     *
     * [cursor] applies only to a log topic (`event`, `session:<id>:stream`): the controller
     * first replays what came after it. The flow completes when the controller reports that
     * an append-only topic does not exist, such as the stream of a deleted session.
     *
     * A chunk is acknowledged only after the collector has taken all of its messages. The
     * controller sends nothing more on the subscription until then, so a slow collector slows
     * the controller down instead of letting messages pile up in memory.
     */
    fun subscribe(topic: String, cursor: String? = null): Flow<LiveMessage> = flow {
        val deliveries = Channel<Delivery>(Channel.UNLIMITED)
        val subscription = Subscription(topic, cursor, deliveries)
        events.send(Event.Subscribed(subscription))
        try {
            for (delivery in deliveries) {
                for (message in delivery.messages) emit(message)
                delivery.taken?.let { events.trySend(it) }
            }
        } finally {
            events.trySend(Event.Unsubscribed(subscription))
        }
    }

    /**
     * Connects, and connects again after every drop, until the coroutine is cancelled or the
     * controller refuses the API key.
     */
    private suspend fun superviseConnection() {
        val supervisor = currentCoroutineContext().job
        var wait = FIRST_WAIT
        var connectedBefore = false
        while (true) {
            publishState(
                supervisor,
                if (connectedBefore) LiveConnectionState.Reconnecting else LiveConnectionState.Connecting,
            )
            val ticket = try {
                api.createWsTicket().ticket
            } catch (e: ControllerApiException) {
                if (e.httpStatus == HTTP_UNAUTHORIZED) {
                    publishState(supervisor, LiveConnectionState.SignedOut)
                    return
                }
                null
            } catch (_: IOException) {
                null
            } catch (_: SerializationException) {
                null
            }
            if (ticket != null) {
                val connectedFor = runConnection(ticket, supervisor)
                if (connectedFor != null) {
                    connectedBefore = true
                    publishState(supervisor, LiveConnectionState.Reconnecting)
                    // A connection that outlasted the longest wait shows the controller can be
                    // reached, so the backoff starts over rather than continuing from long ago.
                    if (connectedFor >= MAX_WAIT) wait = FIRST_WAIT
                }
            }
            delay(shortenByJitter(wait))
            wait = minOf(wait * 2, MAX_WAIT)
        }
    }

    /**
     * Opens one socket, says hello with [ticket], and handles events until the socket ends.
     * Returns how long the connection lasted after the hello reply, or null when the hello
     * never succeeded. [supervisor] is the job of the loop that calls it.
     */
    private suspend fun runConnection(ticket: String, supervisor: Job): Duration? = coroutineScope {
        val url = api.origin.newBuilder().encodedPath("/ws").build()
        val socket = httpClient.newWebSocket(Request.Builder().url(url).build(), SocketListener(events))
        val connection = Connection(socket, timers = this, supervisor)
        var stopping = false
        try {
            connection.sendRequest("hello", WireJson.encodeToJsonElement(LiveHello.serializer(), LiveHello(1, ticket)))
            launch {
                delay(HELLO_TIMEOUT)
                events.send(Event.HelloOverdue(socket))
            }
            while (true) {
                if (!handleEvent(connection, events.receive())) break
            }
            connection.connectedAt?.elapsedNow()
        } catch (e: CancellationException) {
            stopping = true
            throw e
        } finally {
            coroutineContext.cancelChildren()
            if (stopping) socket.close(NORMAL_CLOSURE, null) else socket.cancel()
            for (subscription in subscriptions) subscription.requestId = null
        }
    }

    /** Handles one event. Returns false when the connection must end. */
    private fun handleEvent(connection: Connection, event: Event): Boolean {
        if (event is Event.SocketEvent && event.socket !== connection.socket) return true
        return when (event) {
            is Event.Subscribed -> {
                subscriptions += event.subscription
                !connection.helloSucceeded || connection.sendSubscribe(event.subscription)
            }
            is Event.Unsubscribed -> unsubscribe(connection, event.subscription)
            is Event.FrameReceived -> handleFrameText(connection, event.text)
            is Event.SocketEnded -> false
            is Event.HelloOverdue -> connection.helloSucceeded
            is Event.PingDue -> sendPing(connection)
            is Event.PingOverdue -> connection.outstandingPingId != event.requestId
            is Event.RetryDue -> retrySubscription(connection, event.subscription)
            // A subscription that ended after the chunk arrived must not be acknowledged.
            is Event.ChunkTaken ->
                event.requestId !in connection.subscriptionsByRequestId ||
                    connection.send(buildFrame("Ack", event.requestId))
        }
    }

    /** Forgets [subscription] and, when it is open on the socket, interrupts it. */
    private fun unsubscribe(connection: Connection, subscription: Subscription): Boolean {
        subscriptions -= subscription
        val requestId = subscription.requestId ?: return true
        subscription.requestId = null
        connection.subscriptionsByRequestId -= requestId
        return connection.send(buildFrame("Interrupt", requestId))
    }

    private fun handleFrameText(connection: Connection, text: String): Boolean {
        val frames = try {
            when (val element = WireJson.parseToJsonElement(text)) {
                is JsonArray -> element.map { it as JsonObject }
                else -> listOf(element as JsonObject)
            }
        } catch (_: SerializationException) {
            return false
        } catch (_: ClassCastException) {
            return false
        }
        return frames.all { handleFrame(connection, it) }
    }

    private fun handleFrame(connection: Connection, frame: JsonObject): Boolean {
        val requestId = frame.readString("requestId")
        return when (frame.readString("_tag")) {
            "Exit" -> handleExit(connection, requestId ?: return true, frame["exit"] as? JsonObject ?: return false)
            "Chunk" -> handleChunk(connection, requestId ?: return true, frame["values"] as? JsonArray ?: return false)
            // The controller could not parse a frame this app sent, so a reply may never come.
            "Defect" -> false
            else -> true
        }
    }

    private fun handleExit(connection: Connection, requestId: String, exit: JsonObject): Boolean {
        val succeeded = exit.readString("_tag") == "Success"
        if (requestId == HELLO_REQUEST_ID && !connection.helloSucceeded) {
            return succeeded && startConnection(connection)
        }
        if (requestId == connection.outstandingPingId) {
            connection.outstandingPingId = null
            return succeeded
        }
        val subscription = connection.subscriptionsByRequestId.remove(requestId) ?: return true
        subscription.requestId = null
        return handleSubscriptionEnd(connection, subscription, readFailureCode(exit))
    }

    /** Marks the connection as up after the hello reply, makes every subscription and starts the pings. */
    private fun startConnection(connection: Connection): Boolean {
        connection.helloSucceeded = true
        connection.connectedAt = timeSource.markNow()
        publishState(connection.supervisor, LiveConnectionState.Connected(api.origin.host))
        connection.timers.launch {
            while (true) {
                delay(PING_INTERVAL)
                events.send(Event.PingDue(connection.socket))
            }
        }
        for (subscription in subscriptions.toList()) {
            subscription.retryWait = FIRST_WAIT
            // Taps sent before this connection are lost.
            resetIfCursorless(subscription)
            if (!connection.sendSubscribe(subscription)) return false
        }
        return true
    }

    private fun sendPing(connection: Connection): Boolean {
        if (!connection.helloSucceeded) return true
        val requestId = connection.sendRequest("ping", JsonObject(emptyMap())) ?: return false
        connection.outstandingPingId = requestId
        connection.timers.launch {
            delay(PING_TIMEOUT)
            events.send(Event.PingOverdue(connection.socket, requestId))
        }
        return true
    }

    /**
     * Passes every value of a chunk to its subscriber in order. The subscriber's flow sends
     * [Event.ChunkTaken] back once its collector has taken them all, and the chunk is
     * acknowledged then. A chunk with nothing to pass on is acknowledged at once.
     */
    private fun handleChunk(connection: Connection, requestId: String, values: JsonArray): Boolean {
        val subscription = connection.subscriptionsByRequestId[requestId] ?: return true
        val messages = values.mapNotNull(::decodeLiveMessage)
        for (message in messages) {
            if (message is LiveMessage.Appended && message.delta.cursor != null) {
                subscription.cursor = message.delta.cursor
            }
        }
        if (messages.isEmpty()) return connection.send(buildFrame("Ack", requestId))
        subscription.deliveries.trySend(Delivery(messages, Event.ChunkTaken(connection.socket, requestId)))
        return true
    }

    /**
     * Decides what happens after the controller ends a subscription with [code] (null when
     * the failure carried no error code). Returns false when the whole connection must end.
     */
    private fun handleSubscriptionEnd(connection: Connection, subscription: Subscription, code: ApiErrorCode?): Boolean {
        when {
            // The API key is gone. Only a new connection's ticket fetch can tell whether there
            // is still a valid key, so this connection ends.
            code == ApiErrorCode.Unauthenticated -> return false
            // The topic names a session that does not exist, and retrying cannot fix that.
            code == ApiErrorCode.NotFound && subscription.isAppendOnly -> {
                subscriptions -= subscription
                subscription.deliveries.close()
            }
            // The log rejected the cursor, so the subscription starts again from the head.
            code == ApiErrorCode.Validation && subscription.isAppendOnly && subscription.cursor != null -> {
                subscription.cursor = null
                subscription.deliveries.trySend(Delivery(listOf(LiveMessage.Reset)))
                return connection.sendSubscribe(subscription)
            }
            // Falling behind (`cap_exceeded`), a failed read, or anything else: try again after
            // a growing wait, so an error that keeps repeating costs little.
            else -> {
                val wait = subscription.retryWait
                subscription.retryWait = minOf(wait * 2, MAX_WAIT)
                connection.timers.launch {
                    delay(shortenByJitter(wait))
                    events.send(Event.RetryDue(connection.socket, subscription))
                }
            }
        }
        return true
    }

    private fun retrySubscription(connection: Connection, subscription: Subscription): Boolean {
        if (subscription !in subscriptions) return true
        resetIfCursorless(subscription)
        return connection.sendSubscribe(subscription)
    }

    /**
     * Tells an append-only subscriber with no cursor, such as a tap, that it is about to start
     * again from the head and has lost what was sent in between.
     */
    private fun resetIfCursorless(subscription: Subscription) {
        if (subscription.isAppendOnly && subscription.cursor == null) {
            subscription.deliveries.trySend(Delivery(listOf(LiveMessage.Reset)))
        }
    }

    /** Shortens [wait] by up to a fifth at random, so many waiters do not wake together. */
    private fun shortenByJitter(wait: Duration): Duration = wait * (1 - JITTER * random())

    /**
     * One open socket and the requests in flight on it. [timers] runs the socket's timers and
     * ends with it; [supervisor] is the job of the loop that opened the socket.
     */
    private inner class Connection(val socket: WebSocket, val timers: CoroutineScope, val supervisor: Job) {
        private var nextRequestId = 0
        var helloSucceeded = false
        var connectedAt: TimeMark? = null
        var outstandingPingId: String? = null
        val subscriptionsByRequestId = HashMap<String, Subscription>()

        /** Sends a frame. Returns false when the socket is closed or closing. */
        fun send(frame: JsonObject): Boolean = socket.send(frame.toString())

        /** Sends a request and returns its id, or null when the socket would not take it. */
        fun sendRequest(tag: String, payload: JsonElement): String? {
            val requestId = (nextRequestId++).toString()
            val frame = buildJsonObject {
                put("_tag", "Request")
                put("id", requestId)
                put("tag", tag)
                put("payload", payload)
                // The controller closes the socket with code 1011 on a request without headers.
                put("headers", JsonArray(emptyList()))
            }
            return if (send(frame)) requestId else null
        }

        fun sendSubscribe(subscription: Subscription): Boolean {
            val payload = WireJson.encodeToJsonElement(
                LiveSubscribe.serializer(),
                LiveSubscribe(subscription.topic, subscription.cursor),
            )
            val requestId = sendRequest("subscribe", payload) ?: return false
            subscription.requestId = requestId
            subscriptionsByRequestId[requestId] = subscription
            return true
        }
    }

    private companion object {
        const val HELLO_REQUEST_ID = "0"
        const val HTTP_UNAUTHORIZED = 401
        const val NORMAL_CLOSURE = 1000
        const val JITTER = 0.2
        val FIRST_WAIT = 1.seconds
        val MAX_WAIT = 30.seconds
        val PING_INTERVAL = 30.seconds
        val PING_TIMEOUT = 10.seconds
        val HELLO_TIMEOUT = 10.seconds
    }
}

/** One collector's subscription to a topic. Touched only by the connection's event loop. */
private class Subscription(
    val topic: String,
    /** The last cursor a log topic sent, or the one the collector started from. */
    var cursor: String?,
    /** Where the event loop puts the messages for the collector. */
    val deliveries: SendChannel<Delivery>,
) {
    val isAppendOnly = topic == "event" || topic.endsWith(":stream") || topic.endsWith(":tap")

    /** The id of the subscribe request on the current connection, or null when none is open. */
    var requestId: String? = null
    var retryWait: Duration = 1.seconds
}

/**
 * Messages the event loop passes to one subscriber's flow: the messages of one chunk, or a
 * [LiveMessage.Reset] the connection made itself. [taken] goes back to the event loop once the
 * collector has taken every message, so the chunk is acknowledged only then.
 */
private class Delivery(val messages: List<LiveMessage>, val taken: Event.ChunkTaken? = null)

/** Something the connection's event loop handles. */
private sealed interface Event {
    class Subscribed(val subscription: Subscription) : Event
    class Unsubscribed(val subscription: Subscription) : Event

    /** An event that belongs to one socket, and is dropped once that socket is gone. */
    sealed interface SocketEvent : Event {
        val socket: WebSocket
    }

    class FrameReceived(override val socket: WebSocket, val text: String) : SocketEvent
    class SocketEnded(override val socket: WebSocket) : SocketEvent
    class HelloOverdue(override val socket: WebSocket) : SocketEvent
    class PingDue(override val socket: WebSocket) : SocketEvent
    class PingOverdue(override val socket: WebSocket, val requestId: String) : SocketEvent
    class RetryDue(override val socket: WebSocket, val subscription: Subscription) : SocketEvent

    /** The collector took every message of the chunk sent on [requestId]. */
    class ChunkTaken(override val socket: WebSocket, val requestId: String) : SocketEvent
}

/** Passes what OkHttp reports about a socket to the connection's event loop. */
private class SocketListener(private val events: SendChannel<Event>) : WebSocketListener() {
    override fun onMessage(webSocket: WebSocket, text: String) {
        events.trySend(Event.FrameReceived(webSocket, text))
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        events.trySend(Event.SocketEnded(webSocket))
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        events.trySend(Event.SocketEnded(webSocket))
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        events.trySend(Event.SocketEnded(webSocket))
    }
}

/** Builds a client frame that names one request, such as an `Ack` or an `Interrupt`. */
private fun buildFrame(tag: String, requestId: String): JsonObject = buildJsonObject {
    put("_tag", tag)
    put("requestId", requestId)
}

private val logger = Logger.getLogger(LiveConnection::class.java.name)

/**
 * Decodes one value of a `Chunk`. Returns null for a message this build does not know, and
 * for one that does not match its schema. A malformed value is logged and skipped, so it
 * neither ends the connection nor holds back the rest of its chunk.
 */
private fun decodeLiveMessage(value: JsonElement): LiveMessage? {
    val message = value as? JsonObject ?: return null
    return try {
        when (message.readString("_tag")) {
            "invalidate" -> LiveMessage.Invalidated(WireJson.decodeFromJsonElement(Invalidate.serializer(), message))
            "delta" -> LiveMessage.Appended(WireJson.decodeFromJsonElement(Delta.serializer(), message))
            else -> null
        }
    } catch (e: SerializationException) {
        // Only the tag and the error's type are logged. The message, and the error's text,
        // which quotes the JSON it failed on, can hold transcript text.
        logger.log(Level.WARNING, "Skipped a live message of type ${message.readString("_tag")} that does not match its schema (${e.javaClass.simpleName})")
        null
    }
}

/**
 * Returns the error code of a failed `Exit`: the code of its first `Fail` cause, whose error
 * is the same envelope HTTP errors use. Returns null for a success, or a failure with no
 * `Fail` cause, such as an interrupt or a defect.
 */
private fun readFailureCode(exit: JsonObject): ApiErrorCode? {
    val causes = exit["cause"] as? JsonArray ?: return null
    val fail = causes.firstOrNull { (it as? JsonObject)?.readString("_tag") == "Fail" } as? JsonObject ?: return null
    val error = fail["error"] ?: return null
    return try {
        WireJson.decodeFromJsonElement(ApiErrorEnvelope.serializer(), error).error.code
    } catch (_: SerializationException) {
        null
    }
}

/** Returns the string or number at [key] as text, or null when there is none. */
private fun JsonObject.readString(key: String): String? = (this[key] as? JsonPrimitive)?.content
