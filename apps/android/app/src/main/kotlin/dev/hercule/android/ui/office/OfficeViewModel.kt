package dev.hercule.android.ui.office

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.hercule.android.app.AppGraph
import dev.hercule.android.office.OfficeRow
import dev.hercule.android.office.buildOffice
import dev.hercule.android.ui.CallFailures
import dev.hercule.android.ui.STOP_AFTER_MILLIS
import dev.hercule.android.ui.observeLists
import dev.hercule.android.ui.readFromClient
import dev.hercule.android.ui.tickEveryMinute
import dev.hercule.android.wire.ApprovalDecision
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

/** Holds the Office screen's state, built from the store, and answers its ask card. */
class OfficeViewModel(private val graph: AppGraph) : ViewModel() {
    /** The failures of [decide], for the screen to show. */
    val calls = CallFailures()

    /** The Office, or null until the store has read every list. Its ages are redone each minute. */
    val state: StateFlow<OfficeUiState?> = graph.client
        .readFromClient { client ->
            combine(client.store.observeLists(), tickEveryMinute()) { lists, now ->
                lists?.let {
                    OfficeUiState(
                        buildOffice(it.threads, it.assistants, it.currentSessions, it.runners, it.projects, now),
                        it.projects,
                    )
                }
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_AFTER_MILLIS), null)

    /** Answers the Request of [row], the ask card's, with [decision]. */
    fun decide(row: OfficeRow, decision: ApprovalDecision) {
        // The ask card is drawn only for a row with a session and an approval Request.
        val sessionId = row.sessionId ?: return
        val requestId = row.request?.requestId ?: return
        calls.launchCall(viewModelScope, graph.client.value) { it.respondToApprovalRequest(sessionId, requestId, decision) }
    }
}

