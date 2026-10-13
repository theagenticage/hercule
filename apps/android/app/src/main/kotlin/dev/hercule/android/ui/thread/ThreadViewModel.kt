package dev.hercule.android.ui.thread

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.hercule.android.app.AppGraph
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.office.decideThreadPose
import dev.hercule.android.ui.AnsweredRequests
import dev.hercule.android.ui.CallFailures
import dev.hercule.android.ui.STOP_AFTER_MILLIS
import dev.hercule.android.ui.observeLists
import dev.hercule.android.ui.readFromClient
import dev.hercule.android.ui.tickEveryMinute
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.QuestionAnswers
import dev.hercule.android.wire.SessionInputPayload
import java.time.ZoneId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn

/** Holds the state of the thread whose session is [sessionId], and sends its answers and messages. */
class ThreadViewModel(private val graph: AppGraph, private val sessionId: String) : ViewModel() {
    /** The failures of the calls this screen makes, for the screen to show. */
    val calls = CallFailures()

    private val answered = AnsweredRequests()

    /**
     * The thread, or null until the store has read the lists and the transcript, and while the
     * store holds no thread with this session id.
     */
    val state: StateFlow<ThreadUiState?> = graph.client
        .readFromClient { client ->
            combine(
                client.store.observeLists(),
                client.store.observeTranscript(sessionId),
                tickEveryMinute(),
                answered.ids,
            ) { lists, transcript, now, answeredRequestIds ->
                val session = lists?.threads?.find { it.id == sessionId }
                if (lists == null || transcript == null || session == null) return@combine null
                val runner = lists.runners.find { it.id == session.runnerId }
                ThreadUiState(
                    title = session.title,
                    face = OfficeFace(session.id, decideThreadPose(session, runner), isAssistant = false),
                    projectName = lists.projects.find { it.id == session.projectId }?.name,
                    blocks = buildThreadBlocks(transcript.rows, session.openRequests, transcript.tails),
                    openRequest = session.openRequests.firstOrNull(),
                    openRequestAnswered = session.openRequests.firstOrNull()?.requestId in answeredRequestIds,
                    waitingCount = lists.countWaiting(),
                    now = now,
                    zone = ZoneId.systemDefault(),
                )
            }
        }
        // Every streamed token rebuilds the blocks of the whole transcript, which is too much
        // work for the main thread in a long thread.
        .flowOn(Dispatchers.Default)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_AFTER_MILLIS), null)

    /** Answers the open approval Request with [decision], unless it is answered already. */
    fun decide(decision: ApprovalDecision) {
        val requestId = state.value?.openRequest?.requestId ?: return
        answered.launchAnswer(calls, viewModelScope, graph.client.value, requestId) {
            it.respondToApprovalRequest(sessionId, requestId, decision)
        }
    }

    /** Answers the open question Request with [answers], unless it is answered already. */
    fun answer(answers: QuestionAnswers) {
        val requestId = state.value?.openRequest?.requestId ?: return
        answered.launchAnswer(calls, viewModelScope, graph.client.value, requestId) {
            it.respondToQuestion(sessionId, requestId, answers)
        }
    }

    /** Sends [text] to the thread's session, and calls [onFailure] when it was not sent. */
    fun send(text: String, onFailure: () -> Unit) {
        calls.launchCall(viewModelScope, graph.client.value, onFailure) { it.sendSessionInput(sessionId, SessionInputPayload(text)) }
    }
}
