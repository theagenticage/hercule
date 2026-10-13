package dev.hercule.android.app

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.widget.Toast
import androidx.annotation.StringRes
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.hercule.android.R
import dev.hercule.android.alerts.AlertActionHandler
import dev.hercule.android.alerts.AlertChannels
import dev.hercule.android.alerts.AlertKey
import dev.hercule.android.alerts.AlertMemoryStore
import dev.hercule.android.alerts.AlertPipeline
import dev.hercule.android.alerts.AlertPoster
import dev.hercule.android.controller.ControllerApi
import dev.hercule.android.controller.ControllerApiException
import dev.hercule.android.credentials.ApiKeyUnreadableException
import dev.hercule.android.credentials.CredentialStore
import dev.hercule.android.credentials.LastSignIn
import dev.hercule.android.credentials.StoredCredentials
import dev.hercule.android.service.ControllerWatchService
import dev.hercule.android.wire.ApiErrorCode
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.ProviderException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient

/** How [AppGraph.signIn] ended. */
sealed interface SignInResult {
    /** The phone is signed in and the controller watch service is starting. */
    data object SignedIn : SignInResult

    /** The address is not an http or https URL, so nothing was sent. */
    data object BadUrl : SignInResult

    /** Nothing answered at the address, or the answer was cut off. */
    data object Unreachable : SignInResult

    /**
     * The controller refused, or the server at the address is not a controller. [message] is
     * shown to the user as it is. A wrong user name or password arrives here, with the
     * controller's own message, which is "the username or password is incorrect".
     */
    data class Refused(val message: String) : SignInResult

    /**
     * The controller accepted, but the phone could not store the new API Key, for example
     * because its Keystore failed. The key was revoked again, so the phone is not signed in.
     */
    data object NotStored : SignInResult

    /**
     * Like [NotStored], but the revoke failed too, for [revokeFailure]. The API Key
     * [apiKeyName] still works on the controller with nobody holding it, so the user has to
     * revoke it in the web app's settings, where it is listed under that name.
     */
    data class NotStoredNorRevoked(val apiKeyName: String, val revokeFailure: String) : SignInResult
}

/**
 * How [AppGraph.signOut] ended. The phone is signed out either way. [revokeFailure] is null
 * when the controller revoked the API Key, and otherwise says why it did not: the key then
 * still works, and the user should revoke it in the web app's settings.
 */
data class SignOutResult(val revokeFailure: String?)

/**
 * The app's long-lived objects, shared by the screens, the controller watch service and the
 * receivers. There is one, held by the app's [android.app.Application].
 *
 * While the phone is signed in and the controller watch service runs, [client] holds the
 * [ControllerClient] the screens read; the service opens it with [openClient]. Signing in and
 * out, and the end of a sign-in the controller refused, go through here, so that the
 * credentials, the alerts and the connection always change together.
 */
class AppGraph(
    private val context: Context,
    private val credentialStore: CredentialStore,
    private val alertMemoryStore: AlertMemoryStore,
    private val poster: AlertPoster,
    private val httpClient: OkHttpClient,
    /** What the app still has to ask for so that alerts arrive in the background. */
    val backgroundPermissions: BackgroundPermissions,
) {
    /** The scope of work that must outlive a [ControllerClient], such as ending one. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // Signing in, signing out, restoring a sign-in, ending a refused one and opening a client
    // take turns. Otherwise a restore or a reconnect that read the credentials just before a
    // sign-out cleared them would start the connection again for a signed-out phone.
    private val signInLock = Mutex()
    private val clientLock = Mutex()
    private val mutableClient = MutableStateFlow<ControllerClient?>(null)
    private val mutableFollowedSessionId = MutableStateFlow<String?>(null)

    /** The open client while the controller watch service runs, and null otherwise. */
    val client: StateFlow<ControllerClient?> = mutableClient.asStateFlow()

    /**
     * The destination the screen in front shows, or null when none of the app's screens is in
     * front. The screens set it; nothing alerts for the destination it names.
     */
    val keyOnScreen = MutableStateFlow<AlertKey?>(null)

    /** The session id of the thread the Live Update follows, or null when none is followed. */
    val followedSessionId: StateFlow<String?> = mutableFollowedSessionId.asStateFlow()

    /**
     * Emits whether credentials are stored, and again each time that changes, such as when a
     * sign-out or a refused API Key clears them. The app opens sign-in when it turns false.
     */
    val hasCredentials: Flow<Boolean> = credentialStore.hasCredentials

    /**
     * Returns the controller URL and user name of the last sign-in, or null when the phone was
     * never signed in or the stored file cannot be read. A sign-out keeps them, so the sign-in
     * form starts filled in.
     */
    suspend fun readLastSignIn(): LastSignIn? = try {
        credentialStore.readLastSignIn()
    } catch (_: IOException) {
        null
    }

    /**
     * Returns whether the phone is signed in, and starts the controller watch service when it is.
     * The app calls it when it opens.
     */
    suspend fun restoreSignIn(): Boolean = signInLock.withLock {
        val isSignedIn = readCredentials() != null
        if (isSignedIn) startControllerWatchService()
        isSignedIn
    }

    /** Checks whether credentials are stored, without starting anything. */
    suspend fun isSignedIn(): Boolean = readCredentials() != null

    /**
     * Signs in to the controller at [url] as [userName], and starts the controller watch service.
     *
     * [url] may leave out the scheme, which is then `http`; only its origin is kept. The
     * login token is used once, to create the phone's own API Key named "Android - <model>",
     * and is then logged out, whether the API Key was created or not. Errors are returned as a
     * [SignInResult] the screen shows; this never throws for a refusal or a network failure.
     */
    suspend fun signIn(url: String, userName: String, password: String): SignInResult {
        val origin = parseControllerOrigin(url) ?: return SignInResult.BadUrl
        val minted = try {
            val login = ControllerApi(origin, null, httpClient).login(userName, password)
            val loginApi = ControllerApi(origin, login.token, httpClient)
            try {
                loginApi.createApiKey("Android - ${Build.MODEL}")
            } finally {
                logOutLoginToken(loginApi)
            }
        } catch (e: ControllerApiException) {
            return SignInResult.Refused(e.error.message)
        } catch (_: IOException) {
            return SignInResult.Unreachable
        } catch (_: SerializationException) {
            return SignInResult.Refused("the server at $origin did not answer like a controller")
        }
        return signInLock.withLock { storeSignIn(StoredCredentials(origin.toString(), userName, minted.id, minted.token), minted.name) }
    }

    /**
     * Logs out the login token [loginApi] calls with. A login token stays valid for 30 days, so
     * it is not left alive once the API Key is minted. A failed logout is ignored, as
     * `hercule login` ignores it: the sign-in itself already succeeded or failed.
     */
    private suspend fun logOutLoginToken(loginApi: ControllerApi) {
        try {
            loginApi.logout()
        } catch (_: ControllerApiException) {
        } catch (_: IOException) {
        } catch (_: SerializationException) {
        }
    }

    /**
     * Replaces whatever sign-in was stored with [credentials] and starts the controller watch
     * service. Returns [SignInResult.NotStored], after revoking the new key, when the phone
     * cannot store it, and [SignInResult.NotStoredNorRevoked], naming the key by
     * [apiKeyName], when the revoke fails too.
     */
    private suspend fun storeSignIn(credentials: StoredCredentials, apiKeyName: String): SignInResult {
        closeClient()
        // Memory left from an earlier sign-in would make the first list compare against
        // another account's Requests. With none stored, the first list only records them.
        alertMemoryStore.clear()
        try {
            credentialStore.save(credentials)
        } catch (e: Exception) {
            if (!isStorageFailure(e)) throw e
            // A key the phone cannot keep would stay valid on the controller with nobody
            // holding it, so it is revoked straight away.
            val revokeFailure = revokeApiKey(credentials) ?: return SignInResult.NotStored
            return SignInResult.NotStoredNorRevoked(apiKeyName, revokeFailure)
        }
        startControllerWatchService()
        return SignInResult.SignedIn
    }

    /**
     * Signs out: stops the connection, removes every alert, the alert memory and the
     * credentials, and then revokes the phone's API Key. The phone is signed out even when the
     * revoke fails; the result then says why, because the key still works.
     *
     * Everything on the phone is cleared before the revoke is sent, so a slow controller never
     * leaves the phone half signed out. The revoke runs in the graph's own scope, so it is sent
     * even when the screen that asked closes as soon as the credentials are gone.
     */
    suspend fun signOut(): SignOutResult {
        val credentials = signInLock.withLock {
            val credentials = readCredentials()
            // The connection stops first. Otherwise a reconnect in between would find the key
            // refused and report a sign-out the user did not ask about.
            stopControllerWatchService()
            clearSignIn()
            credentials
        }
        val revokeFailure = credentials?.let { scope.async { revokeApiKey(it) }.await() }
        return SignOutResult(revokeFailure)
    }

    /**
     * Signs out as [signOut] does, without waiting for it, and shows a toast when the
     * controller did not revoke the API Key. The You screen calls it: the screen closes as
     * soon as the credentials are cleared, before the revoke has an answer.
     */
    fun signOutLater() {
        scope.launch {
            val revokeFailure = signOut().revokeFailure ?: return@launch
            withContext(Dispatchers.Main) {
                Toast.makeText(context, context.getString(R.string.signed_out_key_not_revoked, revokeFailure), Toast.LENGTH_LONG).show()
            }
        }
    }

    /**
     * Returns the open client, or opens one from the stored credentials and starts its alert
     * pipeline. Returns null when nobody is signed in. Only the controller watch service calls it,
     * so a client exists exactly while the service runs.
     */
    suspend fun openClient(): ControllerClient? = signInLock.withLock {
        clientLock.withLock { openStoredClient() }
    }

    /** Returns the open client, or opens one as [openClient] says. Call it holding both locks. */
    private suspend fun openStoredClient(): ControllerClient? {
        mutableClient.value?.let { return it }
        val credentials = readCredentials() ?: return null
        val client = ControllerClient(credentials, httpClient)
        val pipeline = AlertPipeline(client.store, alertMemoryStore, keyOnScreen, mutableFollowedSessionId, poster::apply)
        // Without a handler a failed pipeline would crash the app.
        val pipelineFailureHandler = CoroutineExceptionHandler { _, error ->
            Log.e("AppGraph", "The alert pipeline stopped", error)
            endFailedPipeline(client)
        }
        client.scope.launch(pipelineFailureHandler) { pipeline.run() }
        mutableClient.value = client
        return client
    }

    /**
     * Closes [client] when it is still the open one, and closes the open client when [client]
     * is null. Returns once nothing of it runs.
     */
    suspend fun closeClient(client: ControllerClient? = null) = clientLock.withLock {
        val open = mutableClient.value ?: return@withLock
        if (client != null && client !== open) return@withLock
        open.close()
        mutableClient.value = null
        mutableFollowedSessionId.value = null
    }

    /** Closes [client], as [closeClient] does, without waiting for it to stop. */
    fun closeClientLater(client: ControllerClient) {
        scope.launch { closeClient(client) }
    }

    /**
     * Ends a sign-in the controller no longer accepts, without the user asking: stops the
     * connection, clears what sign-out clears, and tells the user with an alert. Runs in the
     * graph's own scope, because the caller's coroutine may belong to the client it closes.
     */
    fun endRefusedSignIn() {
        scope.launch {
            signInLock.withLock {
                stopControllerWatchService()
                clearSignIn()
            }
            // After clearSignIn, whose clearAll would remove it.
            postAppAlert(R.string.signed_out_key_refused)
        }
    }

    /**
     * Stops the controller watch service and closes [client] after its alert pipeline failed,
     * and tells the user with an alert. Otherwise no alert would arrive while the watch
     * notification still said Connected. The credentials stay: opening the app starts the
     * service, and a new pipeline, again.
     */
    private fun endFailedPipeline(client: ControllerClient) {
        scope.launch {
            signInLock.withLock {
                // A sign-in or sign-out since then already replaced or closed this client.
                if (mutableClient.value !== client) return@launch
                stopControllerWatchService()
            }
            postAppAlert(R.string.alerts_stopped)
        }
    }

    /**
     * Starts the controller watch service when the phone is signed in and no client is open,
     * such as after the alert pipeline failed or the service could not start in the
     * background. The app calls it each time it comes to the front.
     */
    suspend fun startStoppedControllerWatchService() {
        if (mutableClient.value == null && hasCredentials.first()) startControllerWatchService()
    }

    /**
     * Returns a handler for an alert's buttons, or null when nobody is signed in. It calls the
     * controller over plain HTTP, so it works without the controller watch service, such as in a
     * process Android started only to run a tapped button.
     */
    suspend fun openAlertActionHandler(): AlertActionHandler? {
        val api = mutableClient.value?.api ?: readCredentials()?.let(::buildApi) ?: return null
        return ControllerAlertActionHandler(api)
    }

    /**
     * Starts the controller watch service. Android refuses when the app is in the background and no
     * exemption applies; the user is then told to open the app, never left disconnected
     * without a word.
     */
    fun startControllerWatchService() {
        try {
            ContextCompat.startForegroundService(context, Intent(context, ControllerWatchService::class.java))
        } catch (_: ForegroundServiceStartNotAllowedException) {
            postAppAlert(R.string.connection_not_started)
        }
    }

    /**
     * Posts an alert about the app itself, such as a sign-out, that opens the app when tapped.
     * It is posted on the Request channel, because the user has to act on it.
     */
    fun postAppAlert(@StringRes text: Int) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val notification = NotificationCompat.Builder(context, AlertChannels.WAITING)
            .setSmallIcon(R.drawable.ic_stat_mark)
            .setContentTitle(context.getString(R.string.app_alert_title))
            .setContentText(context.getString(text))
            .setStyle(NotificationCompat.BigTextStyle().bigText(context.getString(text)))
            .setContentIntent(launch?.let { PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE) })
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(APP_ALERT_ID, notification)
    }

    /**
     * Returns the stored credentials, or null when nobody is signed in or they cannot be read.
     *
     * - Credentials whose API Key can never be decrypted again, such as after the Keystore
     *   key was lost, are of no use: they are cleared and the user is told to sign in again.
     * - A failure that may pass, such as a Keystore that is not ready just after boot, keeps
     *   the credentials: the user is told to open the app again, and the next read may work.
     */
    private suspend fun readCredentials(): StoredCredentials? = try {
        credentialStore.read()
    } catch (_: ApiKeyUnreadableException) {
        credentialStore.removeApiKey()
        postAppAlert(R.string.signed_out_key_unreadable)
        null
    } catch (e: Exception) {
        if (!isStorageFailure(e)) throw e
        postAppAlert(R.string.credentials_not_read)
        null
    }

    private fun buildApi(credentials: StoredCredentials) =
        ControllerApi(credentials.controllerUrl.toHttpUrl(), credentials.apiKey, httpClient)

    /** Stops the controller watch service and closes the client, and returns once the client has stopped. */
    private suspend fun stopControllerWatchService() {
        context.stopService(Intent(context, ControllerWatchService::class.java))
        closeClient()
    }

    /**
     * Revokes the phone's API Key and returns null, or returns why that failed. A key the
     * controller already refuses was revoked elsewhere, which is what signing out wants.
     */
    private suspend fun revokeApiKey(credentials: StoredCredentials): String? = try {
        buildApi(credentials).revokeApiKey(credentials.apiKeyId)
        null
    } catch (e: ControllerApiException) {
        if (e.error.code == ApiErrorCode.Unauthenticated) null else e.error.message
    } catch (_: IOException) {
        "the controller could not be reached"
    } catch (_: SerializationException) {
        "the controller's reply could not be read"
    }

    /** Removes every alert, the alert memory and the API Key, in that order. */
    private suspend fun clearSignIn() {
        poster.clearAll()
        alertMemoryStore.clear()
        credentialStore.removeApiKey()
    }

    private companion object {
        // Alerts are tagged with their key; this one is untagged, so its id cannot collide.
        const val APP_ALERT_ID = 10

        /**
         * Checks whether [error] is a failure of the phone's own storage: the Keystore, its
         * cipher, or the DataStore file. These may pass, so the stored credentials are kept.
         */
        fun isStorageFailure(error: Exception): Boolean =
            error is GeneralSecurityException || error is ProviderException || error is IOException
    }
}

/**
 * Parses what the user typed as the controller's address and returns its origin, or null
 * when it is not an http or https URL. An address without a scheme gets `http://`, because a
 * controller on a tailnet is usually reached that way.
 */
internal fun parseControllerOrigin(text: String): HttpUrl? {
    val trimmed = text.trim()
    val withScheme = if ("://" in trimmed) trimmed else "http://$trimmed"
    val url = withScheme.toHttpUrlOrNull() ?: return null
    return url.newBuilder().encodedPath("/").query(null).fragment(null).username("").password("").build()
}
