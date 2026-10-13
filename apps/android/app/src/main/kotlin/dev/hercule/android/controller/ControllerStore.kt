package dev.hercule.android.controller

import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.Invalidate
import dev.hercule.android.wire.InvalidateKind
import dev.hercule.android.wire.Project
import dev.hercule.android.wire.Runner
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.TapItem
import dev.hercule.android.wire.TranscriptRow
import dev.hercule.android.wire.WireJson
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonElement

/** A thread's transcript as the screens draw it: the stored rows, and the streaming tails. */
data class ThreadTranscript(
    /** The rows held, ordered by position. */
    val rows: List<TranscriptRow>,
    /** For each assistant message still streaming, the text no row holds yet, by item id. */
    val tails: Map<String, String>,
)

/**
 * The app's in-memory view of the controller, shared by the screens and the background
 * service. Each list is null until its first read answers, so "not read yet" and "empty" look
 * different.
 *
 * The lists are read again when the live connection reports a change, following the topics
 * the desktop app uses:
 *
 * - `session`: the threads, when the push names a session in no conversation (or names
 *   nothing, which means everything); an assistant's current session, when the push names a
 *   session of the assistant's main conversation.
 * - `assistant`: the assistants.
 * - `runner`: the runners.
 * - Projects have no topic, so they are read each time the connection comes up: changes made
 *   while it was down would otherwise go unseen.
 *
 * Pushes that arrive while a read is running are merged into one read after it.
 */
class ControllerStore(
    private val api: ControllerApi,
    private val live: LiveConnection,
    private val scope: CoroutineScope,
) {
    private val mutableThreadSessions = MutableStateFlow<List<Session>?>(null)
    private val mutableCurrentAssistantSessions = MutableStateFlow<Map<String, Session?>>(emptyMap())
    private val mutableAssistants = MutableStateFlow<List<Assistant>?>(null)
    private val mutableRunners = MutableStateFlow<List<Runner>?>(null)
    private val mutableProjects = MutableStateFlow<List<Project>?>(null)

    /** Every thread. */
    val threadSessions: StateFlow<List<Session>?> = mutableThreadSessions.asStateFlow()

    /**
     * Each assistant's current session: the newest session of its main conversation, by
     * assistant id. An assistant is absent until its session is read, and null when its
     * conversation has no session yet.
     */
    val currentAssistantSessions: StateFlow<Map<String, Session?>> = mutableCurrentAssistantSessions.asStateFlow()

    /** Every assistant. */
    val assistants: StateFlow<List<Assistant>?> = mutableAssistants.asStateFlow()

    /** Every runner. */
    val runners: StateFlow<List<Runner>?> = mutableRunners.asStateFlow()

    /** Every project. */
    val projects: StateFlow<List<Project>?> = mutableProjects.asStateFlow()

    private val conversationMessageFlows = ConcurrentHashMap<String, StateFlow<List<ConversationMessage>?>>()
    private val transcriptFlows = ConcurrentHashMap<String, StateFlow<ThreadTranscript?>>()

    /**
     * Subscribes to the topics above and starts the live connection. Call it once. The first
     * push of every subscription names nothing, so it triggers the first read of every list.
     */
    fun start() {
        scope.launch { followInvalidates("session") { rereadSessions(it) } }
        scope.launch { followInvalidates("assistant") { rereadAssistants() } }
        scope.launch { followInvalidates("runner") { readOrNull { api.listRunners() }?.let { mutableRunners.value = it } } }
        scope.launch {
            live.state.collect { state ->
                if (state is LiveConnectionState.Connected) {
                    readOrNull { api.listProjects() }?.let { mutableProjects.value = it }
                }
            }
        }
        live.start()
    }

    /**
     * Returns the messages of a conversation, oldest first, kept current while the flow is
     * collected. Holds the newest 50 messages read, plus every message that arrived since.
     */
    fun observeConversationMessages(conversationId: String): StateFlow<List<ConversationMessage>?> =
        conversationMessageFlows.computeIfAbsent(conversationId) {
            channelFlow {
                var held = emptyList<ConversationMessage>()
                followInvalidates("conversation") { invalidate ->
                    if (invalidate.ids.isNotEmpty() && conversationId !in invalidate.ids) return@followInvalidates
                    val newest = readOrNull {
                        api.readNewestConversationMessages(conversationId, CONVERSATION_PAGE_LIMIT)
                    } ?: return@followInvalidates
                    held = mergeConversationMessages(held, newest)
                    send(held)
                }
            }.stateIn(scope, SharingStarted.WhileSubscribed(KEEP_ALIVE_MILLIS), null)
        }

    /**
     * Returns the transcript of the session [sessionId], with its streaming tails, kept
     * current while the flow is collected. The flow completes when the session no longer
     * exists.
     */
    fun observeTranscript(sessionId: String): StateFlow<ThreadTranscript?> =
        transcriptFlows.computeIfAbsent(sessionId) {
            channelFlow { followTranscript(sessionId) }
                .stateIn(scope, SharingStarted.WhileSubscribed(KEEP_ALIVE_MILLIS), null)
        }

    /**
     * Reads the transcript over HTTP, then follows the stream from its last row and the tap.
     * Every change sends a fresh [ThreadTranscript].
     */
    private suspend fun ProducerScope<ThreadTranscript>.followTranscript(sessionId: String) {
        // The stream and the tap are collected by two coroutines, so changes take turns.
        val lock = Mutex()
        val tails = TailBuffer()
        var rows = readOrNull { api.readTranscript(sessionId) }.orEmpty()
        suspend fun publish() = send(ThreadTranscript(rows, tails.copyTails()))

        lock.withLock {
            // Taps sent before the subscription are lost, so items already open are skipped.
            tails.skipOpenItems(rows)
            publish()
        }
        launch {
            live.subscribe("session:$sessionId:tap").collect { message ->
                lock.withLock {
                    when (message) {
                        is LiveMessage.Appended ->
                            message.delta.items.mapNotNull { decodeOrNull(it, TapItem.serializer()) }.forEach(tails::appendTap)
                        LiveMessage.Reset -> tails.skipOpenItems(rows)
                        is LiveMessage.Invalidated -> Unit
                    }
                    publish()
                }
            }
        }
        // Cursor 0 replays the whole log for a transcript with no rows yet. Without a cursor,
        // rows written between the read and the subscription would be missing.
        val cursor = (rows.lastOrNull()?.position ?: 0).toString()
        live.subscribe("session:$sessionId:stream", cursor).collect { message ->
            when (message) {
                is LiveMessage.Appended -> lock.withLock {
                    val incoming = message.delta.items.mapNotNull { decodeOrNull(it, TranscriptRow.serializer()) }
                    val fresh = findNewRows(rows, incoming)
                    if (fresh.isEmpty()) return@withLock
                    tails.applyRows(fresh)
                    rows = (rows + fresh).sortedBy { it.position }
                    publish()
                }
                LiveMessage.Reset -> {
                    // The stream lost its place, so rows may be missing: read them all again.
                    val reread = readOrNull { api.readTranscript(sessionId) }
                    lock.withLock {
                        if (reread != null) rows = reread
                        tails.skipOpenItems(rows)
                        publish()
                    }
                }
                is LiveMessage.Invalidated -> Unit
            }
        }
        // The stream ended because the session no longer exists.
        channel.close()
    }

    /**
     * Re-reads what a `session` push may have changed: the threads when it names a session
     * in no conversation, and the current session of each assistant whose main conversation
     * it names. A push that names nothing re-reads both.
     */
    private suspend fun rereadSessions(invalidate: Invalidate) {
        val everything = invalidate.ids.isEmpty()
        val conversationIds = invalidate.conversationIds.orEmpty()
        if (everything || invalidate.ids.any { conversationIds[it] == null }) {
            readOrNull { api.listThreadSessions() }?.let { mutableThreadSessions.value = it }
        }
        val named = conversationIds.values.filterNotNull().toSet()
        val affected = mutableAssistants.value.orEmpty().filter { everything || it.mainConversationId in named }
        readCurrentSessions(affected)
    }

    /**
     * Re-reads the assistants, then reads the current session of every assistant that has
     * none read yet, and forgets the sessions of assistants that are gone.
     */
    private suspend fun rereadAssistants() {
        val assistants = readOrNull { api.listAssistants() } ?: return
        mutableAssistants.value = assistants
        val ids = assistants.map { it.id }.toSet()
        mutableCurrentAssistantSessions.update { sessions -> sessions.filterKeys { it in ids } }
        val known = mutableCurrentAssistantSessions.value.keys
        readCurrentSessions(assistants.filter { it.id !in known })
    }

    private suspend fun readCurrentSessions(assistants: List<Assistant>) {
        for (assistant in assistants) {
            val session = try {
                api.readCurrentConversationSession(assistant.mainConversationId)
            } catch (e: Exception) {
                if (isReadFailure(e)) continue else throw e
            }
            mutableCurrentAssistantSessions.update { it + (assistant.id to session) }
        }
    }

    /**
     * Collects the invalidates of [topic] and calls [reread] once per burst: the invalidates
     * that arrive while a re-read runs are merged into one, so a burst costs one more read.
     */
    private suspend fun followInvalidates(topic: String, reread: suspend (Invalidate) -> Unit) {
        val pending = Channel<Invalidate>(Channel.UNLIMITED)
        coroutineScope {
            launch {
                live.subscribe(topic).filterIsInstance<LiveMessage.Invalidated>().collect { pending.send(it.invalidate) }
                pending.close()
            }
            for (first in pending) {
                var merged = first
                while (true) merged = mergeInvalidates(merged, pending.tryReceive().getOrNull() ?: break)
                reread(merged)
            }
        }
    }

    private companion object {
        const val CONVERSATION_PAGE_LIMIT = 50
        const val KEEP_ALIVE_MILLIS = 5_000L
    }
}

/**
 * Merges two invalidates of one topic into one that covers both: one that names nothing
 * covers everything, otherwise the ids and the conversations of the sessions are combined.
 */
internal fun mergeInvalidates(first: Invalidate, second: Invalidate): Invalidate {
    val conversationIds = if (first.conversationIds == null && second.conversationIds == null) {
        null
    } else {
        first.conversationIds.orEmpty() + second.conversationIds.orEmpty()
    }
    val ids = if (first.ids.isEmpty() || second.ids.isEmpty()) emptyList() else (first.ids + second.ids).distinct()
    return Invalidate(ids, InvalidateKind.Updated, conversationIds)
}

/**
 * Merges the newest page of a conversation's messages ([newest], newest first, as
 * `conversation.queryMessages` returns it) into [held] (oldest first) and returns the result,
 * oldest first. When the page does not reach back to the newest held message, messages are
 * missing between the two, so the held messages are dropped rather than shown with a gap.
 */
internal fun mergeConversationMessages(
    held: List<ConversationMessage>,
    newest: List<ConversationMessage>,
): List<ConversationMessage> {
    val fresh = newest.sortedBy { it.position }
    val oldestFresh = fresh.firstOrNull()?.position ?: return held
    val newestHeld = held.lastOrNull()?.position
    val kept = if (newestHeld != null && oldestFresh > newestHeld + 1) emptyList() else held
    return (kept.associateBy { it.position } + fresh.associateBy { it.position }).values.sortedBy { it.position }
}

/** Returns the rows of [incoming] whose position [held] does not hold, in arrival order. */
internal fun findNewRows(held: List<TranscriptRow>, incoming: List<TranscriptRow>): List<TranscriptRow> {
    val positions = held.mapTo(HashSet()) { it.position }
    return incoming.filter { it.position !in positions }
}

/**
 * Runs a read and returns its result, or null when the controller could not be reached or
 * refused the read. The next push or reconnect reads again.
 */
private suspend fun <T> readOrNull(read: suspend () -> T): T? = try {
    read()
} catch (e: Exception) {
    if (isReadFailure(e)) null else throw e
}

/** Checks whether [e] is a failed read rather than a bug or a cancellation. */
private fun isReadFailure(e: Exception): Boolean =
    e is IOException || e is ControllerApiException || e is SerializationException

/**
 * Decodes one item of a delta, or returns null when it does not decode, so one bad item does
 * not drop the rest.
 */
private fun <T> decodeOrNull(item: JsonElement, serializer: KSerializer<T>): T? = try {
    WireJson.decodeFromJsonElement(serializer, item)
} catch (_: SerializationException) {
    null
}
