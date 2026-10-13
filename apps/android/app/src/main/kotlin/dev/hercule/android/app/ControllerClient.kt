package dev.hercule.android.app

import dev.hercule.android.controller.ControllerApi
import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.controller.LiveConnection
import dev.hercule.android.credentials.StoredCredentials
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient

/**
 * Everything the app holds while it is signed in to a controller: the HTTP API, the one live
 * connection, and the store the screens read. All of it runs in [scope], so [close] stops all
 * of it at once.
 *
 * Creating one starts the store, which starts the live connection.
 */
class ControllerClient(val credentials: StoredCredentials, httpClient: OkHttpClient) {
    /** The scope every coroutine of the signed-in app runs in, the alert pipeline among them. */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** The controller's HTTP API, signed in with the stored API Key. */
    val api = ControllerApi(credentials.controllerUrl.toHttpUrl(), credentials.apiKey, httpClient)

    /** The live connection, which reports where it stands in [LiveConnection.state]. */
    val live = LiveConnection(api, httpClient, scope)

    /** The lists the screens and the alerts read. */
    val store = ControllerStore(api, live, scope).apply { start() }

    /**
     * Closes the live connection and cancels every coroutine in [scope], and returns once they
     * have all ended. Nothing the client started touches the alerts after this returns.
     */
    suspend fun close() {
        live.stop()
        scope.coroutineContext.job.cancelAndJoin()
    }
}
