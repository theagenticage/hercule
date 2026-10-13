package dev.hercule.android.alerts

import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.TranscriptRow
import java.io.IOException
import java.util.logging.Level
import java.util.logging.Logger
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.sample

/**
 * Turns the store's lists into alerts. On every change, at most [DECISION_INTERVAL] later, it
 * builds an [AlertSnapshot], runs [decideAlerts] against the stored [AlertMemory], hands the
 * decision to [applyDecision], and stores the decision's memory.
 *
 * It reads only what alerts need: the threads, the assistants with their current sessions,
 * the recent messages of each assistant's main conversation, and the transcript of the one
 * followed thread. [followedSessionId] is kept equal to the followed thread's session id.
 */
class AlertPipeline(
    private val store: ControllerStore,
    private val memoryStore: AlertMemoryStore,
    private val keyOnScreen: StateFlow<AlertKey?>,
    private val followedSessionId: MutableStateFlow<String?>,
    private val applyDecision: (AlertDecision) -> Unit,
) {
    private lateinit var memory: MutableStateFlow<AlertMemory>
    private var isFirstList = false

    // True while the stored memory may differ from [memory]: before the first decision is
    // stored, and after a write failed.
    private var isMemoryUnstored = false

    /**
     * Runs until cancelled. Fails when the stored memory cannot be read or a list of the store
     * fails; a failed write of the memory is retried at the next decision instead.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    suspend fun run() {
        loadMemory()
        val followedId = combine(memory, keyOnScreen, ::decideFollowedSessionId)
            .distinctUntilChanged()
            .onEach { followedSessionId.value = it }
        // The transcript changes with every streamed token, in its tails. The rules read only
        // its rows, so a token that changes no row starts no decision.
        val followedTranscript = followedId.flatMapLatest { sessionId ->
            if (sessionId == null) {
                flowOf(FollowedTranscript(null, emptyList()))
            } else {
                store.observeTranscript(sessionId).map { FollowedTranscript(sessionId, it?.rows) }
            }
        }.distinctUntilChanged()
        val lists = combine(
            store.threadSessions,
            store.assistants,
            store.currentAssistantSessions,
            observeAssistantMessages(),
        ) { threads, assistants, currentSessions, messages -> AlertLists(threads, assistants, currentSessions, messages) }
        coalesceSnapshots(combine(lists, followedTranscript, keyOnScreen, ::buildAlertSnapshot)).collect { decide(it) }
    }

    /**
     * Reads the stored memory. The first list counts as a first list, which records what is open
     * and alerts for nothing, only when no memory is stored. That is the case right after sign-in.
     *
     * After the app restarts or reconnects, the list is compared against the stored memory
     * instead. A Request that opened while the phone was off or out of reach then alerts once
     * it is seen, which is the point of an alert. The stored memory still keeps old Requests
     * and old messages from alerting again.
     */
    internal suspend fun loadMemory() {
        val stored = memoryStore.read()
        isFirstList = stored == null
        isMemoryUnstored = stored == null
        memory = MutableStateFlow(stored ?: AlertMemory())
    }

    /** Decides the alerts for [snapshot], applies them, and stores the new memory. */
    internal suspend fun decide(snapshot: AlertSnapshot) {
        val decision = decideAlerts(snapshot, memory.value, isFirstList)
        applyDecision(decision)
        // The first decision is always stored, even when it is empty: with nothing stored,
        // the next start would be a first list again and miss what opened in between.
        if (isMemoryUnstored || decision.memory != memory.value) storeMemory(decision.memory)
        isFirstList = false
        memory.value = decision.memory
    }

    /**
     * Stores [decided]. A failed write, such as on a full disk, is logged and retried at the
     * next decision. Alerts keep working meanwhile, because the decisions read [memory]; only
     * a restart before a write succeeds would compare against the older stored memory.
     */
    private suspend fun storeMemory(decided: AlertMemory) {
        isMemoryUnstored = try {
            memoryStore.write(decided)
            false
        } catch (e: IOException) {
            logger.log(Level.WARNING, "The alert memory could not be stored; the next decision tries again", e)
            true
        }
    }

    /**
     * Returns the recent messages of every listed assistant's main conversation, by
     * conversation id; a conversation not read yet maps to null.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    private fun observeAssistantMessages(): Flow<Map<String, List<ConversationMessage>?>> =
        store.assistants
            .map { assistants -> assistants.orEmpty().map { it.mainConversationId }.distinct() }
            .distinctUntilChanged()
            .flatMapLatest { conversationIds ->
                if (conversationIds.isEmpty()) {
                    flowOf(emptyMap())
                } else {
                    combine(conversationIds.map { id -> store.observeConversationMessages(id).map { id to it } }) { it.toMap() }
                }
            }

}

/**
 * Pushes come in bursts: a turn ending changes a session, then its transcript. Deciding once
 * per interval keeps the alerts from flickering.
 */
internal val DECISION_INTERVAL = 250.milliseconds

private val logger = Logger.getLogger(AlertPipeline::class.java.name)

/**
 * Returns the complete snapshots of [snapshots], at most one per [DECISION_INTERVAL]: the
 * newest one of each interval in which a snapshot arrived.
 *
 * A quiet period that restarts with every change would never end while a thread streams, and
 * every other alert would wait for the stream to stop. Sampling bounds that wait.
 */
@OptIn(FlowPreview::class)
internal fun coalesceSnapshots(snapshots: Flow<AlertSnapshot?>): Flow<AlertSnapshot> =
    snapshots.filterNotNull().sample(DECISION_INTERVAL)

/** The transcript of the followed thread [sessionId]: null rows while it is still being read. */
internal data class FollowedTranscript(val sessionId: String?, val rows: List<TranscriptRow>?)

/** The store's lists as the pipeline reads them; null where a list is still being read. */
internal data class AlertLists(
    val threads: List<Session>?,
    val assistants: List<Assistant>?,
    val currentSessions: Map<String, Session?>,
    val messages: Map<String, List<ConversationMessage>?>,
)

/**
 * Builds the snapshot the rules decide on, or returns null while anything it holds is still
 * being read: the threads, the assistants, any assistant's current session, the recent
 * messages of any assistant, or the transcript of a followed thread that is listed.
 *
 * The rules forget whatever a list leaves out. A snapshot built from half-read lists would
 * empty the memory, and the next complete list would then alert for old Requests and old
 * messages, so a pass is skipped until everything has been read.
 */
internal fun buildAlertSnapshot(lists: AlertLists, transcript: FollowedTranscript, keyOnScreen: AlertKey?): AlertSnapshot? {
    val threads = lists.threads ?: return null
    val sources = lists.assistants?.map { assistant ->
        if (assistant.id !in lists.currentSessions) return null
        val recentMessages = lists.messages[assistant.mainConversationId] ?: return null
        AssistantAlertSource(assistant, lists.currentSessions[assistant.id], recentMessages)
    } ?: return null
    // A followed thread that left the list has no Live Update, so its transcript is not needed.
    val isFollowedListed = transcript.sessionId != null && threads.any { it.id == transcript.sessionId }
    val followedRows = if (isFollowedListed) transcript.rows ?: return null else emptyList()
    return AlertSnapshot(threads, sources, followedRows, keyOnScreen)
}
