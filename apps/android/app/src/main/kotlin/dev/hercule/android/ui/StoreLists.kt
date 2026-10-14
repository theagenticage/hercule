package dev.hercule.android.ui

import dev.hercule.android.app.ControllerClient
import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.office.listWaiting
import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.Project
import dev.hercule.android.wire.Runner
import dev.hercule.android.wire.Session
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf

/**
 * The store's lists once every one of them has been read: the [threads], the [assistants] and
 * each one's current session in [currentSessions] (an assistant with no session is left out),
 * the [runners] and the [projects]. The Office and the Thread screen both build from them.
 */
data class StoreLists(
    val threads: List<Session>,
    val assistants: List<Assistant>,
    val currentSessions: Map<String, Session>,
    val runners: List<Runner>,
    val projects: List<Project>,
) {
    /** Counts the colleagues waiting on the user, as the Office's Waiting on you lane does. */
    fun countWaiting(): Int = listWaiting(threads.filter { it.runId == null }, assistants, currentSessions).size
}

/** Returns the store's lists, or null while any of them has not been read yet. */
fun ControllerStore.observeLists(): Flow<StoreLists?> =
    combine(threadSessions, assistants, currentAssistantSessions, runners, projects) { threads, assistants, current, runners, projects ->
        if (threads == null || assistants == null || runners == null || projects == null) {
            null
        } else {
            val currentSessions = buildMap { current.forEach { (assistantId, session) -> if (session != null) put(assistantId, session) } }
            StoreLists(threads, assistants, currentSessions, runners, projects)
        }
    }

/**
 * Returns what [read] reads from the open client, read again whenever a client opens or closes.
 * The flow holds null while no client is open: the phone is signed out, or the controller
 * watch service has not started yet.
 */
@OptIn(ExperimentalCoroutinesApi::class)
fun <T> StateFlow<ControllerClient?>.readFromClient(read: (ControllerClient) -> Flow<T?>): Flow<T?> =
    flatMapLatest { client -> if (client == null) flowOf(null) else read(client) }
