package dev.hercule.android.ui.assistant

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.hercule.android.app.AppGraph
import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.faces.Pose
import dev.hercule.android.markdown.DocumentKey
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.office.decideAssistantPose
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
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.ConversationSenderRole
import dev.hercule.android.wire.QuestionAnswers
import java.time.ZoneId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flowOn
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

    /** Answers the approval Request [requestId] with [decision], unless it is answered already. */
    fun decide(requestId: String, decision: ApprovalDecision) {
        val sessionId = findOpenRequestSessionId(requestId) ?: return
        answered.launchAnswer(calls, viewModelScope, graph.client.value, requestId) {
            it.respondToApprovalRequest(sessionId, requestId, decision)
        }
    }

    /** Answers the question Request [requestId] with [answers], unless it is answered already. */
    fun answer(requestId: String, answers: QuestionAnswers) {
        val sessionId = findOpenRequestSessionId(requestId) ?: return
        answered.launchAnswer(calls, viewModelScope, graph.client.value, requestId) {
            it.respondToQuestion(sessionId, requestId, answers)
        }
    }

    /**
     * Returns the id of the session whose open Request is [requestId], or reports that nothing
     * was sent and returns null when that Request is no longer open. The assistant's current
     * session can change between the tap and the answer, so it is read only while it still
     * holds the Request the user saw.
     */
    private fun findOpenRequestSessionId(requestId: String): String? {
        val assistant = state.value
        if (assistant?.openRequest?.requestId == requestId && assistant.sessionId != null) return assistant.sessionId
        calls.report("That Request is no longer open. Nothing was sent.")
        return null
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
    return channelFlow {
        val documents = MessageDocuments(store.documentCache, this)
        combine(lists, messages, runningTurn.throttleToFrames(), answeredRequestIds, documents.parsed) { lists, messages, runningTurn, answeredIds, _ ->
            val assistant = lists?.assistants?.find { it.id == assistantId }
            if (assistant == null || messages == null) return@combine null
            val session = lists.currentSessions[assistantId]
            val runner = session?.let { lists.runners.find { runner -> runner.id == it.runnerId } }
            val pose = decideAssistantPose(session, runner)
            val openRequest = session?.openRequests?.firstOrNull()
            val openReply = decideOpenReply(messages, runningTurn?.rows.orEmpty(), session, assistant.reply)
            val answerSoFar = buildOpenReplyText(openReply, runningTurn?.tails.orEmpty())
            val answerWriting = openReply?.openItemId != null
            val (answerDocument, messageDocuments) = readConversationDocuments(documents, assistant.mainConversationId, answerSoFar, answerWriting, messages)
            AssistantUiState(
                name = assistant.name,
                face = OfficeFace(assistant.id, pose, isAssistant = true),
                answering = pose == Pose.Working,
                answerSoFar = answerSoFar,
                answerWriting = answerWriting,
                messages = messages,
                sessionId = session?.id,
                openRequest = openRequest,
                openRequestAnswered = openRequest != null && openRequest.requestId in answeredIds,
                // The store reads no reminders yet, so the reminder card is never drawn.
                reminder = null,
                zone = ZoneId.systemDefault(),
                answerDocument = answerDocument,
                documents = messageDocuments,
                documentCache = store.documentCache,
                conversationId = assistant.mainConversationId,
            )
        }.collect { send(it) }
    }.flowOn(Dispatchers.Default)
}

/**
 * Reads the parsed markdown of the Conversation [conversationId] from [documents], the newest
 * first: the [answerSoFar], which the assistant may still be [answerWriting], then each of
 * [messages] but notices, which are drawn as plain text. Returns the answer's, or null, and the
 * messages' by message id. A message with no document ready yet is left out, and its row parses
 * it itself.
 */
internal fun readConversationDocuments(
    documents: MessageDocuments,
    conversationId: String,
    answerSoFar: String?,
    answerWriting: Boolean,
    messages: List<ConversationMessage>,
): Pair<ParsedMessage?, Map<String, ParsedMessage>> {
    documents.startPass()
    val kept = HashSet<DocumentKey>()
    val answer = answerSoFar?.takeIf { it.isNotEmpty() }?.let { text ->
        kept += buildDocumentKey(conversationId, ANSWER_DOCUMENT_ID, MessageAuthor.Agent)
        documents.read(conversationId, ANSWER_DOCUMENT_ID, MessageAuthor.Agent, text, answerWriting)
    }
    val parsed = HashMap<String, ParsedMessage>()
    for (message in messages.asReversed()) {
        val author = when (message.senderRole) {
            ConversationSenderRole.Notice -> continue
            ConversationSenderRole.Owner -> MessageAuthor.User
            else -> MessageAuthor.Agent
        }
        kept += buildDocumentKey(conversationId, message.id, author)
        documents.read(conversationId, message.id, author, message.text, writing = false)?.let { parsed[message.id] = it }
    }
    documents.finishPass(conversationId, kept)
    return answer to parsed
}

/** The id the answer so far is parsed under: no stored message has it. */
private const val ANSWER_DOCUMENT_ID = "answer-so-far"
