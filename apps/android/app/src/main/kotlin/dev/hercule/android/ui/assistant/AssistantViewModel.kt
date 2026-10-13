package dev.hercule.android.ui.assistant

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.hercule.android.app.AppGraph
import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.office.decideAssistantPose
import dev.hercule.android.ui.CallFailures
import dev.hercule.android.ui.STOP_AFTER_MILLIS
import dev.hercule.android.ui.observeLists
import dev.hercule.android.ui.readFromClient
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

/** Holds the state of the assistant [assistantId]'s main Conversation, and sends the user's messages. */
class AssistantViewModel(private val graph: AppGraph, private val assistantId: String) : ViewModel() {
    /** The failures of [send], for the screen to show. */
    val calls = CallFailures()

    /**
     * The assistant's Conversation, or null until the store has read the lists and the
     * messages, and while the store holds no assistant with this id.
     */
    val state: StateFlow<AssistantUiState?> = graph.client
        .readFromClient { client -> observeAssistantState(client.store, assistantId) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_AFTER_MILLIS), null)

    /** Sends [text] to the assistant's main Conversation. */
    fun send(text: String) {
        val client = graph.client.value
        // The screen is drawn only while the store holds the assistant, so its Conversation is
        // found whenever a client is open.
        val conversationId = client?.store?.assistants?.value?.find { it.id == assistantId }?.mainConversationId
        if (conversationId == null) {
            calls.report("The assistant is not loaded yet. Nothing was sent.")
            return
        }
        calls.launchCall(viewModelScope, client) { it.sendConversationMessage(conversationId, text) }
    }
}

/**
 * Returns the state of the assistant [assistantId]'s main Conversation, kept current from
 * [store] while the flow is collected. It holds null until the store has read the lists and the
 * messages, and while the store holds no assistant with this id.
 *
 * The answer so far comes from the running turn of the assistant's current session, which is
 * followed only while the flow is collected, and only for that one session. Until the running
 * turn is read, the screen draws the stored messages without it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
internal fun observeAssistantState(store: ControllerStore, assistantId: String): Flow<AssistantUiState?> {
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
    return combine(lists, messages, runningTurn) { lists, messages, runningTurn ->
        val assistant = lists?.assistants?.find { it.id == assistantId }
        if (assistant == null || messages == null) return@combine null
        val session = lists.currentSessions[assistantId]
        val runner = session?.let { lists.runners.find { runner -> runner.id == it.runnerId } }
        val pose = decideAssistantPose(session, runner)
        val openReply = decideOpenReply(messages, runningTurn?.rows.orEmpty(), session, assistant.reply)
        AssistantUiState(
            name = assistant.name,
            face = OfficeFace(assistant.id, pose, isAssistant = true),
            answering = pose == Pose.Working,
            answerSoFar = buildOpenReplyText(openReply, runningTurn?.tails.orEmpty()),
            messages = messages,
            // The store reads no reminders yet, so the reminder card is never drawn.
            reminder = null,
            zone = ZoneId.systemDefault(),
        )
    }
}
