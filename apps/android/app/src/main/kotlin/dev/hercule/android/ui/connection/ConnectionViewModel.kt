package dev.hercule.android.ui.connection

import android.content.res.AssetManager
import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.hercule.android.app.AppGraph
import dev.hercule.android.controller.LiveConnectionState
import dev.hercule.android.ui.STOP_AFTER_MILLIS
import dev.hercule.android.ui.observeLists
import dev.hercule.android.ui.readFromClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/** Holds the You screen's state, read from the open client, and signs out. */
@OptIn(ExperimentalCoroutinesApi::class)
class ConnectionViewModel(private val graph: AppGraph, assets: AssetManager) : ViewModel() {
    private val licences = flow { emit(readFontLicences(assets)) }.flowOn(Dispatchers.IO)

    /** How many colleagues wait on the user, 0 while no client is open or its lists are not read yet. */
    private val waitingCount = graph.client.readFromClient { client -> client.store.observeLists().map { it?.countWaiting() } }

    /**
     * The account, the live connection, the font licences and the waiting count. The account is
     * blank and the connection [LiveConnectionState.Stopped] while no client is open.
     */
    val state: StateFlow<ConnectionUiState?> = combine(
        graph.client.flatMapLatest { client ->
            if (client == null) flowOf(null to LiveConnectionState.Stopped) else client.live.state.map { client to it }
        },
        licences,
        waitingCount,
    ) { (client, connection), licences, waitingCount ->
        ConnectionUiState(
            username = client?.credentials?.userName.orEmpty(),
            controllerUrl = client?.credentials?.controllerUrl.orEmpty(),
            connection = connection,
            showsOneUiNote = isOneUi,
            licences = licences,
            waitingCount = waitingCount ?: 0,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_AFTER_MILLIS), null)

    /**
     * Signs the phone out. The app opens sign-in once the credentials are cleared, and a toast
     * says so when the controller did not revoke the API Key, because the key then still
     * works. A second tap revokes nothing: by then no credentials are stored.
     */
    fun signOut() = graph.signOutLater()
}

/** Reads the licences of the three fonts the app ships, from `assets/licenses/`. Fails when one is missing. */
private fun readFontLicences(assets: AssetManager): List<FontLicence> = listOf(
    "Bricolage Grotesque" to "bricolage-grotesque-OFL.txt",
    "Limelight" to "limelight-OFL.txt",
    "Recursive" to "recursive-OFL.txt",
).map { (name, file) -> FontLicence(name, assets.open("licenses/$file").bufferedReader().use { it.readText() }) }

/** True on a Samsung phone, whose One UI needs a developer option before it shows Live Updates. */
private val isOneUi: Boolean get() = Build.MANUFACTURER.equals("samsung", ignoreCase = true)
