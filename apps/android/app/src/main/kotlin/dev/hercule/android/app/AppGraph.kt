package dev.hercule.android.app

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
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
import dev.hercule.android.credentials.StoredCredentials
import dev.hercule.android.service.ConnectionService
import dev.hercule.android.wire.ApiErrorCode
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerializationException
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient

/** How [AppGraph.signIn] ended. */
sealed interface SignInResult {
    /** The phone is signed in and the connection service is starting. */
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
}

/**
 * How [AppGraph.signOut] ended. The phone is signed out either way. [revokeFailure] is null
 * when the controller revoked the API Key, and otherwise says why it did not: the key then
 * still works, and the user should revoke it in the web app's settings.
 */
data class SignOutResult(val revokeFailure: String?)

/**
 * The app's long-lived objects, shared by the screens, the connection service and the
 * receivers. There is one, held by the app's [android.app.Application].
 *
 * While the phone is signed in and the connection service runs, [client] holds the
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
    private val clientLock = Mutex()
    private val mutableClient = MutableStateFlow<ControllerClient?>(null)
    private val mutableFollowedSessionId = MutableStateFlow<String?>(null)

    /** The open client while the connection service runs, and null otherwise. */
    val client: StateFlow<ControllerClient?> = mutableClient.asStateFlow()

    /**
     * The destination the screen in front shows, or null when none of the app's screens is in
     * front. The screens set it; nothing alerts for the destination it names.
     */
    val keyOnScreen = MutableStateFlow<AlertKey?>(null)

    /** The session id of the thread the Live Update follows, or null when none is followed. */
    val followedSessionId: StateFlow<String?> = mutableFollowedSessionId.asStateFlow()

    /**
     * Returns whether the phone is signed in, and starts the connection service when it is.
     * The app calls it when it opens; the boot receiver after a restart or an update.
     */
    suspend fun restoreSignIn(): Boolean {
        val isSignedIn = readCredentials() != null
        if (isSignedIn) startConnectionService()
        return isSignedIn
    }

    /** Checks whether credentials are stored, without starting anything. */
    suspend fun isSignedIn(): Boolean = readCredentials() != null

    /**
     * Signs in to the controller at [url] as [userName], and starts the connection service.
     *
     * [url] may leave out the scheme, which is then `http`; only its origin is kept. The
     * login token is used once, to create the phone's own API Key named "Android - <model>",
     * and is then thrown away. Errors are returned as a [SignInResult] the screen shows; this
     * never throws for a refusal or a network failure.
     */
    suspend fun signIn(url: String, userName: String, password: String): SignInResult {
        val origin = parseControllerOrigin(url) ?: return SignInResult.BadUrl
        val minted = try {
            val login = ControllerApi(origin, null, httpClient).login(userName, password)
            ControllerApi(origin, login.token, httpClient).createApiKey("Android - ${Build.MODEL}")
        } catch (e: ControllerApiException) {
            return SignInResult.Refused(e.error.message)
        } catch (_: IOException) {
            return SignInResult.Unreachable
        } catch (_: SerializationException) {
            return SignInResult.Refused("the server at $origin did not answer like a controller")
        }
        closeClient()
        // Memory left from an earlier sign-in would make the first list compare against
        // another account's Requests. With none stored, the first list only records them.
        alertMemoryStore.clear()
        credentialStore.save(StoredCredentials(origin.toString(), userName, minted.id, minted.token))
        startConnectionService()
        return SignInResult.SignedIn
    }

    /**
     * Signs out: stops the connection, revokes the phone's API Key, and removes every alert,
     * the alert memory and the credentials. The phone is signed out even when the revoke
     * fails; the result then says why, because the key still works.
     */
    suspend fun signOut(): SignOutResult {
        val credentials = readCredentials()
        // The connection stops before the key is revoked. Otherwise a reconnect in between
        // would find the key refused and report a sign-out the user did not ask about.
        stopConnection()
        val revokeFailure = credentials?.let { revokeApiKey(it) }
        clearSignIn()
        return SignOutResult(revokeFailure)
    }

    /**
     * Returns the open client, or opens one from the stored credentials and starts its alert
     * pipeline. Returns null when nobody is signed in. Only the connection service calls it,
     * so a client exists exactly while the service runs.
     */
    suspend fun openClient(): ControllerClient? = clientLock.withLock {
        mutableClient.value?.let { return it }
        val credentials = readCredentials() ?: return null
        val client = ControllerClient(credentials, httpClient)
        val pipeline = AlertPipeline(client.store, alertMemoryStore, keyOnScreen, mutableFollowedSessionId, poster::apply)
        client.scope.launch { pipeline.run() }
        mutableClient.value = client
        client
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
            stopConnection()
            clearSignIn()
            // After clearSignIn, whose clearAll would remove it.
            postAppAlert(R.string.signed_out_key_refused)
        }
    }

    /**
     * Returns a handler for an alert's buttons, or null when nobody is signed in. It calls the
     * controller over plain HTTP, so it works without the connection service, such as in a
     * process Android started only to run a tapped button.
     */
    suspend fun openAlertActionHandler(): AlertActionHandler? {
        val api = mutableClient.value?.api ?: readCredentials()?.let(::buildApi) ?: return null
        return ControllerAlertActionHandler(api)
    }

    /**
     * Starts the connection service. Android refuses when the app is in the background and no
     * exemption applies; the user is then told to open the app, never left disconnected
     * without a word.
     */
    fun startConnectionService() {
        try {
            ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java))
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
     * Returns the stored credentials, or null when nobody is signed in. Credentials whose API
     * Key cannot be decrypted, such as after the Keystore key was lost, are of no use: they
     * are cleared, the user is told to sign in again, and this returns null.
     */
    private suspend fun readCredentials(): StoredCredentials? = try {
        credentialStore.read()
    } catch (_: ApiKeyUnreadableException) {
        credentialStore.clear()
        postAppAlert(R.string.signed_out_key_unreadable)
        null
    }

    private fun buildApi(credentials: StoredCredentials) =
        ControllerApi(credentials.controllerUrl.toHttpUrl(), credentials.apiKey, httpClient)

    /** Stops the connection service and closes the client, and returns once the client has stopped. */
    private suspend fun stopConnection() {
        context.stopService(Intent(context, ConnectionService::class.java))
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

    /** Removes every alert, the alert memory and the credentials, in that order. */
    private suspend fun clearSignIn() {
        poster.clearAll()
        alertMemoryStore.clear()
        credentialStore.clear()
    }

    private companion object {
        // Alerts are tagged with their key; this one is untagged, so its id cannot collide.
        const val APP_ALERT_ID = 10
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
