package dev.hercule.android.ui.threads

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.hercule.android.app.AppGraph
import dev.hercule.android.threads.DONE_SHELF_LIMIT
import dev.hercule.android.threads.DONE_SHELF_STEP
import dev.hercule.android.threads.buildThreadList
import dev.hercule.android.ui.STOP_AFTER_MILLIS
import dev.hercule.android.ui.observeLists
import dev.hercule.android.ui.readFromClient
import dev.hercule.android.ui.tickEveryMinute
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update

/**
 * Holds the Threads screen's state, built from the store, and whether the Done shelf is open.
 *
 * The shelf's state lives here and nowhere else: it lasts while a thread opened from the list is
 * on top, and is forgotten when the user switches tabs, which drops this ViewModel.
 */
class ThreadsViewModel(graph: AppGraph) : ViewModel() {
    /** How many Done threads the shelf shows, or null while it is closed. */
    private val doneLimit = MutableStateFlow<Int?>(null)

    /** The Threads list, or null until the store has read every list. Its ages are redone each minute. */
    val state: StateFlow<ThreadsUiState?> = graph.client
        .readFromClient { client ->
            combine(client.store.observeLists(), tickEveryMinute(), doneLimit) { lists, now, limit ->
                lists?.let {
                    ThreadsUiState(buildThreadList(it.threads, it.runners, it.projects, now, limit), it.projects, doneOpen = limit != null)
                }
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_AFTER_MILLIS), null)

    /** Opens the Done shelf on its newest threads, or closes it. */
    fun toggleDone() {
        doneLimit.update { if (it == null) DONE_SHELF_LIMIT else null }
    }

    /** Shows more of the open Done shelf. */
    fun showMoreDone() {
        doneLimit.update { it?.plus(DONE_SHELF_STEP) }
    }
}
