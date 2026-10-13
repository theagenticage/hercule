package dev.hercule.android.ui.assistant

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.hercule.android.app.AppGraph
import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.office.decideAssistantPose
import dev.hercule.android.ui.AnsweredRequests
import dev.hercule.android.ui.CallFailures
import dev.hercule.android.ui.STOP_AFTER_MILLIS
import dev.hercule.android.ui.observeLists
import dev.hercule.android.ui.readFromClient
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.QuestionAnswers
import java.time.ZoneId
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/**
 * Holds the state of the assistant [assistantId]'s main Conversation, sends the user's messages,
 * and answers the open Request of the assistant's current session.
 */
class AssistantViewModel(private val graph: AppGraph, private val assistantId: String) : ViewModel() {
    /** The failures of the calls this screen makes, for the screen to show. */
    val calls = CallFailures()

    private val answered = AnsweredRequests()

    /**
     * The assistant's Conversation, or null until the store has read the lists and the
     * messages, and while the store holds no assistant with this id.
     */
    val state: StateFlow<AssistantUiState?> = graph.client
        .readFromClient { client -> observeAssistantState(client.store, assistantId, answered.ids) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_AFTER_MILLIS), null)

    /** Sends [text] to the assistant's main Conversation, and calls [onFailure] when it was not sent. */
    fun send(text: String, onFailure: () -> Unit) {
        val client = graph.client.value
        // The screen is drawn only while the store holds the assistant, so its Conversation is
        // found whenever a client is open.
        val conversationId = client?.store?.assistants?.value?.find { it.id == assistantId }?.mainConversationId
        if (conversationId == null) {
            calls.report("The assistant is not loaded yet. Nothing was sent.")
            onFailure()
            return
        }
        calls.launchCall(viewModelScope, client, onFailure) { it.sendConversationMessage(conversationId, text) }
    }

    /** Answers the open approval Request of the current session with [decision], unless it is answered already. */
    fun decide(decision: ApprovalDecision) {
        val assistant = state.value ?: return
        val sessionId = assistant.sessionId ?: return
        val requestId = assistant.openRequest?.requestId ?: return
        answered.launchAnswer(calls, viewModelScope, graph.client.value, requestId) {
            it.respondToApprovalRequest(sessionId, requestId, decision)
        }
    }

    /** Answers the open question Request of the current session with [answers], unless it is answered already. */
    fun answer(answers: QuestionAnswers) {
        val assistant = state.value ?: return
        val sessionId = assistant.sessionId ?: return
        val requestId = assistant.openRequest?.requestId ?: return
        answered.launchAnswer(calls, viewModelScope, graph.client.value, requestId) {
            it.respondToQuestion(sessionId, requestId, answers)
        }
    }
}

/**
 * Returns the state of the assistant [assistantId]'s main Conversation, kept current from
 * [store] while the flow is collected. It holds null until the store has read the lists and the
 * messages, and while the store holds no assistant with this id. [answeredRequestIds] holds the
 * Requests answered from the screen, as [AnsweredRequests.ids] does.
 *
 * The answer so far comes from the running turn of the assistant's current session, which is
 * followed only while the flow is collected, and only for that one session. Until the running
 * turn is read, the screen draws the stored messages without it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
internal fun observeAssistantState(
    store: ControllerStore,
    assistantId: String,
    answeredRequestIds: Flow<Set<String>>,
): Flow<AssistantUiState?> {
    val lists = store.observeLists()
    val messages = lists
        .map { it?.assistants?.find { assistant -> assistant.id == assistantId }?.mainConversationId }
        .distinctUntilChanged()
        .flatMapLatest { conversationId ->
            if (conversationId == null) flowOf(null) else store.observeConversationMessages(conversationId)
        }
    val runningTurn = lists
        .map { it?.currentSessions?.get(assistantId)?.id }
        .distinctUntilChanged()
        .flatMapLatest { sessionId -> if (sessionId == null) flowOf(null) else store.observeRunningTurn(sessionId) }
    return combine(lists, messages, runningTurn, answeredRequestIds) { lists, messages, runningTurn, answeredIds ->
        val assistant = lists?.assistants?.find { it.id == assistantId }
        if (assistant == null || messages == null) return@combine null
        val session = lists.currentSessions[assistantId]
        val runner = session?.let { lists.runners.find { runner -> runner.id == it.runnerId } }
        val pose = decideAssistantPose(session, runner)
        val openRequest = session?.openRequests?.firstOrNull()
        val openReply = decideOpenReply(messages, runningTurn?.rows.orEmpty(), session, assistant.reply)
        AssistantUiState(
            name = assistant.name,
            face = OfficeFace(assistant.id, pose, isAssistant = true),
            answering = pose == Pose.Working,
            answerSoFar = buildOpenReplyText(openReply, runningTurn?.tails.orEmpty()),
            messages = messages,
            sessionId = session?.id,
            openRequest = openRequest,
            openRequestAnswered = openRequest != null && openRequest.requestId in answeredIds,
            // The store reads no reminders yet, so the reminder card is never drawn.
            reminder = null,
            zone = ZoneId.systemDefault(),
        )
    }
}
