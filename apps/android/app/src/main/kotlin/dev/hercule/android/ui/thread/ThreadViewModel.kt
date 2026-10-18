package dev.hercule.android.ui.thread

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.hercule.android.app.AppGraph
import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.markdown.DocumentKey
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.office.decideThreadPose
import dev.hercule.android.threads.findResumeBlockedReason
import dev.hercule.android.ui.AnsweredRequests
import dev.hercule.android.ui.CallFailures
import dev.hercule.android.ui.STOP_AFTER_MILLIS
import dev.hercule.android.ui.markdown.MessageAuthor
import dev.hercule.android.ui.markdown.MessageDocuments
import dev.hercule.android.ui.markdown.ParsedMessage
import dev.hercule.android.ui.markdown.buildDocumentKey
import dev.hercule.android.ui.observeLists
import dev.hercule.android.ui.readFromClient
import dev.hercule.android.ui.throttleToFrames
import dev.hercule.android.ui.tickEveryMinute
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.QuestionAnswers
import dev.hercule.android.wire.SessionInputPayload
import java.time.ZoneId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn

/** Holds the state of the thread whose session is [sessionId], and sends its answers and messages. */
class ThreadViewModel(private val graph: AppGraph, private val sessionId: String) : ViewModel() {
    /** The failures of the calls this screen makes, for the screen to show. */
    val calls = CallFailures()

    private val answered = AnsweredRequests()

    /**
     * The thread, or null until the store has read the lists, and while the store holds no thread
     * with this session id. See [observeThreadState].
     */
    val state: StateFlow<ThreadUiState?> = graph.client
        .readFromClient { client -> observeThreadState(client.store, sessionId, answered.ids) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_AFTER_MILLIS), null)

    /** Answers the approval Request [requestId] with [decision], unless it is answered already. */
    fun decide(requestId: String, decision: ApprovalDecision) {
        answered.launchAnswer(calls, viewModelScope, graph.client.value, requestId) {
            it.respondToApprovalRequest(sessionId, requestId, decision)
        }
    }

    /** Answers the question Request [requestId] with [answers], unless it is answered already. */
    fun answer(requestId: String, answers: QuestionAnswers) {
        answered.launchAnswer(calls, viewModelScope, graph.client.value, requestId) {
            it.respondToQuestion(sessionId, requestId, answers)
        }
    }

    /** Sends [text] to the thread's session, and calls [onFailure] when it was not sent. */
    fun send(text: String, onFailure: () -> Unit) {
        calls.launchCall(viewModelScope, graph.client.value, onFailure) { it.sendSessionInput(sessionId, SessionInputPayload(text)) }
    }
}

/**
 * Reads the parsed markdown of each message of [blocks], the newest first, from [documents], and
 * returns it by block key. A message with no document ready yet is left out, and its row parses
 * it itself.
 */
internal fun readThreadDocuments(documents: MessageDocuments, sessionId: String, blocks: List<ThreadBlock>): Map<String, ParsedMessage> {
    documents.startPass()
    val parsed = HashMap<String, ParsedMessage>()
    val kept = HashSet<DocumentKey>()
    for (block in blocks.asReversed()) {
        val (author, text, writing) = when (block) {
            is AgentBlock -> if (block.text.isEmpty()) continue else Triple(MessageAuthor.Agent, block.text, block.open)
            is UserBlock -> Triple(if (block.senderSessionId == null) MessageAuthor.User else MessageAuthor.AnotherAgent, block.text, false)
            else -> continue
        }
        kept += buildDocumentKey(sessionId, block.key, author)
        documents.read(sessionId, block.key, author, text, writing)?.let { parsed[block.key] = it }
    }
    documents.finishPass(sessionId, kept)
    return parsed
}

/**
 * Returns the state of the thread whose session is [sessionId], kept current from [store] while
 * the flow is collected. It holds null until the store has read the lists, and while the store
 * holds no thread with this session id. [answeredRequestIds] holds the Requests answered from the
 * screen, as [AnsweredRequests.ids] does.
 *
 * The bar is drawn as soon as the lists are read: until the transcript has been read too, the
 * state has no blocks, so a long transcript does not keep the whole screen blank.
 *
 * Everything is worked out off the main thread: the blocks, and the markdown of each message,
 * which [MessageDocuments] parses, the newest first. The transcript is read at most once a
 * frame ([throttleToFrames]), so a burst of tokens builds one state, and no token waits longer
 * than a frame.
 */
internal fun observeThreadState(store: ControllerStore, sessionId: String, answeredRequestIds: Flow<Set<String>>): Flow<ThreadUiState?> =
    channelFlow {
        val blockBuilder = ThreadBlockBuilder()
        val documents = MessageDocuments(store.documentCache, this)
        combine(
            store.observeLists(),
            store.observeTranscript(sessionId).throttleToFrames(),
            tickEveryMinute(),
            answeredRequestIds,
            documents.parsed,
        ) { lists, transcript, now, answeredIds, _ ->
            val session = lists?.threads?.find { it.id == sessionId }
            if (lists == null || session == null) return@combine null
            val runner = lists.runners.find { it.id == session.runnerId }
            val blocks = transcript?.let { blockBuilder.build(it.rows, session.openRequests, it.tails) }.orEmpty()
            ThreadUiState(
                title = session.title,
                face = OfficeFace(session.id, decideThreadPose(session, runner), isAssistant = false),
                projectName = lists.projects.find { it.id == session.projectId }?.name,
                blocks = blocks,
                openRequest = session.openRequests.firstOrNull(),
                openRequestAnswered = session.openRequests.firstOrNull()?.requestId in answeredIds,
                waitingCount = lists.countWaitingThreads(),
                resumeBlockedReason = findResumeBlockedReason(session),
                now = now,
                zone = ZoneId.systemDefault(),
                documents = readThreadDocuments(documents, sessionId, blocks),
            )
        }.collect { send(it) }
    }.flowOn(Dispatchers.Default)

