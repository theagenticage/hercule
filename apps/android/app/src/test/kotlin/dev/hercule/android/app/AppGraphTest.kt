package dev.hercule.android.app

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.graphics.Bitmap
import androidx.core.graphics.drawable.IconCompat
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.R
import dev.hercule.android.alerts.AlertFacePose
import dev.hercule.android.alerts.AlertFaces
import dev.hercule.android.alerts.AlertMemory
import dev.hercule.android.alerts.AlertMemoryStore
import dev.hercule.android.alerts.AlertPoster
import dev.hercule.android.controller.MockController
import dev.hercule.android.controller.awaitValue
import dev.hercule.android.credentials.CredentialStore
import dev.hercule.android.credentials.LastSignIn
import dev.hercule.android.credentials.StoredCredentials
import dev.hercule.android.service.ControllerWatchService
import java.io.File
import java.io.IOException
import java.security.KeyStoreException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import kotlinx.coroutines.cancel
import dev.hercule.android.ui.signin.SignInViewModel
import dev.hercule.android.ui.signin.SignInUiState
import dev.hercule.android.ui.signin.SignInForm
import androidx.lifecycle.viewModelScope
import android.os.Looper

/** Tests signing in and out against a mock controller, on Robolectric for the service intents. */
@RunWith(AndroidJUnit4::class)
class AppGraphTest {
    @get:Rule val folder = TemporaryFolder()

    private val context: Application = ApplicationProvider.getApplicationContext()
    private val aesKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    /** Each request the controller answered: method, path, and the bearer token it carried. */
    private val requests = LinkedBlockingQueue<String>()
    private var revokeReply = MockResponse.Builder().body("{}").build()
    private var logoutReply = MockResponse.Builder().body("{}").build()
    private var createApiKeyReply = MockResponse.Builder()
        .body("""{"id":"k1","name":"Android - robolectric","token":"phone-key","createdAt":"2026-10-13T08:00:00Z"}""").build()

    // When set, the revoke waits for it to open before the controller answers.
    @Volatile
    private var revokeGate: CountDownLatch? = null
    private var logoutGate: CountDownLatch? = null
    private val controller = MockController(::respondHttp)

    @After
    fun stopController() = controller.close()

    private fun respondHttp(request: RecordedRequest): MockResponse {
        val bearer = request.headers["Authorization"]?.removePrefix("Bearer ")
        requests += "${request.method} ${request.url.encodedPath} $bearer"
        return when (request.url.encodedPath) {
            "/api/v1/auth/login" -> if ("\"password\":\"right\"" in request.body!!.utf8()) {
                MockResponse.Builder().body("""{"token":"login-token","expiresAt":"2026-10-20T08:00:00Z"}""").build()
            } else {
                MockResponse.Builder().code(401)
                    .body("""{"error":{"code":"unauthenticated","message":"the username or password is incorrect"}}""").build()
            }
            "/api/v1/auth/logout" -> {
                logoutGate?.await(5, TimeUnit.SECONDS)
                logoutReply
            }
            "/api/v1/api-keys" -> createApiKeyReply
            "/api/v1/api-keys/k1" -> {
                revokeGate?.await(5, TimeUnit.SECONDS)
                revokeReply
            }
            else -> MockResponse.Builder().code(404).build()
        }
    }

    private companion object {
        const val APP_ALERT_ID = 10
    }

    /** Draws nothing: no test here posts an alert. */
    private val faces = object : AlertFaces {
        private val square = IconCompat.createWithBitmap(Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888))
        override fun drawPersonIcon(seedId: String, isAssistant: Boolean, pose: AlertFacePose) = square
        override fun drawTrackerIcon(sessionId: String, pose: AlertFacePose) = square
        override fun readHueColor(sessionId: String) = 0
    }

    private lateinit var credentialDataStore: DataStore<Preferences>
    private lateinit var credentialStore: CredentialStore
    private lateinit var memoryStore: AlertMemoryStore

    /**
     * Builds the graph on DataStore files in a temporary folder, its API Keys encrypted under
     * [encryptionKey], and its credentials and alert memory in the DataStores
     * [wrapCredentialsFile] and [wrapAlertsFile] return.
     */
    private fun TestScope.buildGraph(
        encryptionKey: () -> SecretKey = { aesKey },
        wrapCredentialsFile: (DataStore<Preferences>) -> DataStore<Preferences> = { it },
        wrapAlertsFile: (DataStore<Preferences>) -> DataStore<Preferences> = { it },
    ): AppGraph {
        fun openDataStore(name: String) = PreferenceDataStoreFactory.create(scope = backgroundScope) { File(folder.root, "$name.preferences_pb") }
        credentialDataStore = wrapCredentialsFile(openDataStore("credentials"))
        credentialStore = CredentialStore(credentialDataStore, encryptionKey)
        memoryStore = AlertMemoryStore(wrapAlertsFile(openDataStore("alerts")))
        return AppGraph(
            context,
            credentialStore,
            memoryStore,
            AlertPoster(context, faces),
            OkHttpClient(),
            BackgroundPermissions(context, openDataStore("background_permissions")),
        )
    }

    private fun takeStartedService() = shadowOf(context).nextStartedService?.component?.className

    /** Waits for the app alert and returns its text. */
    private suspend fun TestScope.awaitAppAlertText(): String? {
        val alert = awaitValue { context.getSystemService(NotificationManager::class.java).activeNotifications.singleOrNull { it.id == APP_ALERT_ID } }
        return alert.notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
    }

    /** Returns [file] with writes that fail while [isFull] returns true, as on a full disk. */
    private fun failWritesWhile(file: DataStore<Preferences>, isFull: () -> Boolean) = object : DataStore<Preferences> by file {
        override suspend fun updateData(transform: suspend (Preferences) -> Preferences): Preferences =
            if (isFull()) throw IOException("the disk is full") else file.updateData(transform)
    }

    @Test
    fun `signs in with a new API Key, logs the login token out, and starts the connection`() = runTest {
        val graph = buildGraph()
        memoryStore.write(AlertMemory(followedSessionId = "s-from-before"))

        val result = graph.signIn(controller.origin.toString().removePrefix("http://"), "ada", "right")

        assertEquals(SignInResult.SignedIn, result)
        assertEquals(StoredCredentials(controller.origin.toString(), "ada", "k1", "phone-key"), credentialStore.read())
        assertEquals(
            listOf("POST /api/v1/auth/login null", "POST /api/v1/api-keys login-token", "POST /api/v1/auth/logout login-token"),
            requests.toList(),
        )
        assertNull(memoryStore.read(), "the next list is a first list")
        assertEquals(ControllerWatchService::class.java.name, takeStartedService())
    }

    @Test
    fun `a wrong password is refused with the controller's message, and nothing is stored`() = runTest {
        val graph = buildGraph()

        val result = graph.signIn(controller.origin.toString(), "ada", "wrong")

        assertEquals(SignInResult.Refused("the username or password is incorrect"), result)
        assertNull(credentialStore.read())
        assertNull(takeStartedService())
    }

    @Test
    fun `logs the login token out when the API Key cannot be created`() = runTest {
        val graph = buildGraph()
        createApiKeyReply = MockResponse.Builder().code(500).body("""{"error":{"code":"internal","message":"the database is locked"}}""").build()

        val result = graph.signIn(controller.origin.toString(), "ada", "right")

        assertEquals(SignInResult.Refused("the database is locked"), result)
        assertEquals("POST /api/v1/auth/logout login-token", requests.last())
        assertNull(credentialStore.read())
    }

    @Test
    fun `a sign-in cancelled after the API Key was created still stores the key`() = runTest {
        val graph = buildGraph()
        val gate = CountDownLatch(1)
        logoutGate = gate

        val signIn = async { graph.signIn(controller.origin.toString(), "ada", "right") }
        awaitValue { requests.firstOrNull { it.startsWith("POST /api/v1/auth/logout") } }
        signIn.cancel()
        gate.countDown()

        assertEquals(ControllerWatchService::class.java.name, awaitValue { takeStartedService() })
        assertEquals(StoredCredentials(controller.origin.toString(), "ada", "k1", "phone-key"), credentialStore.read())
    }

    @Test
    fun `a sign-in started while one runs follows the running one`() = runTest {
        val graph = buildGraph()
        val gate = CountDownLatch(1)
        logoutGate = gate

        val first = graph.startSignIn(controller.origin.toString(), "ada", "right")
        awaitValue { requests.firstOrNull { it.startsWith("POST /api/v1/auth/logout") } }
        val second = graph.startSignIn(controller.origin.toString(), "bo", "other")

        assertSame(first, second)
        assertSame(first, graph.findRunningSignIn())
        gate.countDown()
        assertEquals(SignInResult.SignedIn, first.result.await())
        assertNull(graph.findRunningSignIn())
        assertEquals(1, requests.count { it.startsWith("POST /api/v1/auth/login") })
    }

    @Test
    fun `a sign-in screen opened while a closed screen's sign-in runs shows that sign-in and its result`() = runTest {
        val graph = buildGraph()
        val gate = CountDownLatch(1)
        logoutGate = gate
        val closedScreen = SignInViewModel(graph)
        closedScreen.signIn(SignInForm(controller.origin.toString(), "ada", "right"))
        awaitValue { requests.firstOrNull { it.startsWith("POST /api/v1/auth/logout") } }
        closedScreen.viewModelScope.cancel()

        val reopenedScreen = SignInViewModel(graph)
        assertEquals(SignInUiState(controller.origin.toString(), "ada", signingIn = true), reopenedScreen.state.value)
        gate.countDown()

        awaitValue {
            shadowOf(Looper.getMainLooper()).idle()
            reopenedScreen.signedIn.value.takeIf { it }
        }
        assertEquals(1, requests.count { it.startsWith("POST /api/v1/auth/login") })
    }

    @Test
    fun `a failed logout of the login token does not fail the sign-in`() = runTest {
        val graph = buildGraph()
        logoutReply = MockResponse.Builder().code(500).build()

        assertEquals(SignInResult.SignedIn, graph.signIn(controller.origin.toString(), "ada", "right"))
        assertEquals(StoredCredentials(controller.origin.toString(), "ada", "k1", "phone-key"), credentialStore.read())
    }

    @Test
    fun `an address that is not a URL, or that nothing answers at, is reported`() = runTest {
        val graph = buildGraph()
        assertEquals(SignInResult.BadUrl, graph.signIn("not a url", "ada", "right"))
        val origin = controller.origin.toString()
        controller.close()
        assertEquals(SignInResult.Unreachable, graph.signIn(origin, "ada", "right"))
    }

    @Test
    fun `signs out by stopping the connection, revoking the key, and clearing all but the last sign-in`() = runTest {
        val graph = buildGraph()
        graph.signIn(controller.origin.toString(), "ada", "right")
        memoryStore.write(AlertMemory(followedSessionId = "s1"))
        requests.clear()

        val result = graph.signOut()

        assertEquals(SignOutResult(revokeFailure = null), result)
        assertEquals(listOf("DELETE /api/v1/api-keys/k1 phone-key"), requests.toList())
        assertEquals(ControllerWatchService::class.java.name, shadowOf(context).nextStoppedService?.component?.className)
        assertNull(credentialStore.read())
        assertNull(memoryStore.read())
        assertEquals(LastSignIn(controller.origin.toString(), "ada"), graph.readLastSignIn(), "the sign-in form starts filled in")
    }

    @Test
    fun `signs out even when the revoke fails, and says why`() = runTest {
        val graph = buildGraph()
        graph.signIn(controller.origin.toString(), "ada", "right")
        revokeReply = MockResponse.Builder().code(500).body("""{"error":{"code":"internal","message":"the database is locked"}}""").build()

        val result = graph.signOut()

        assertEquals(SignOutResult(revokeFailure = "the database is locked"), result)
        assertNull(credentialStore.read())
    }

    @Test
    fun `a key the phone cannot store is revoked again, and the phone stays signed out`() = runTest {
        val graph = buildGraph(encryptionKey = { throw KeyStoreException("the Keystore is not ready") })

        val result = graph.signIn(controller.origin.toString(), "ada", "right")

        assertEquals(SignInResult.NotStored, result)
        assertEquals("DELETE /api/v1/api-keys/k1 phone-key", requests.last())
        assertFalse(credentialStore.hasCredentials.first())
        assertNull(takeStartedService())
    }

    @Test
    fun `a key minted while the alert memory cannot be cleared is revoked again`() = runTest {
        val graph = buildGraph(wrapAlertsFile = { file ->
            object : DataStore<Preferences> by file {
                override suspend fun updateData(transform: suspend (Preferences) -> Preferences): Preferences =
                    throw IOException("the disk is full")
            }
        })

        val result = graph.signIn(controller.origin.toString(), "ada", "right")

        assertEquals(SignInResult.NotStored, result)
        assertEquals("DELETE /api/v1/api-keys/k1 phone-key", requests.last())
        assertFalse(credentialStore.hasCredentials.first())
        assertNull(takeStartedService())
    }

    @Test
    fun `a key the phone can neither store nor revoke is named, so the user can revoke it`() = runTest {
        val graph = buildGraph(encryptionKey = { throw KeyStoreException("the Keystore is not ready") })
        revokeReply = MockResponse.Builder().code(500).body("""{"error":{"code":"internal","message":"the database is locked"}}""").build()

        val result = graph.signIn(controller.origin.toString(), "ada", "right")

        assertEquals(SignInResult.NotStoredNorRevoked("Android - robolectric", "the database is locked"), result)
        assertFalse(credentialStore.hasCredentials.first())
    }

    @Test
    fun `a sign-out whose API Key cannot be removed still revokes it, and tells the user`() = runTest {
        var isDiskFull = false
        val graph = buildGraph(wrapCredentialsFile = { failWritesWhile(it) { isDiskFull } })
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        graph.signIn(controller.origin.toString(), "ada", "right")
        isDiskFull = true

        val result = graph.signOut()

        assertEquals(SignOutResult(revokeFailure = null), result)
        assertEquals("DELETE /api/v1/api-keys/k1 phone-key", requests.last())
        assertTrue(credentialStore.hasCredentials.first(), "the phone is still signed in")
        assertEquals(context.getString(R.string.sign_in_not_cleared), awaitAppAlertText())
    }

    @Test
    fun `a sign-out whose API Key cannot be read clears the phone and says the key was not revoked`() = runTest {
        val graph = buildGraph(encryptionKey = { throw KeyStoreException("the Keystore is not ready") })
        CredentialStore(credentialDataStore) { aesKey }.save(StoredCredentials(controller.origin.toString(), "ada", "k1", "phone-key"))

        val result = graph.signOut()

        assertEquals(SignOutResult(revokeFailure = context.getString(R.string.api_key_not_read)), result)
        assertFalse(requests.any { it.startsWith("DELETE") }, "nothing is revoked")
        assertFalse(credentialStore.hasCredentials.first())
    }

    @Test
    fun `whether credentials are stored, when the file cannot be read, tells the user and ends`() = runTest {
        val graph = buildGraph(wrapCredentialsFile = { file ->
            object : DataStore<Preferences> by file {
                override val data = flow<Preferences> { throw IOException("the credentials could not be read") }
            }
        })
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)

        assertEquals(emptyList(), graph.hasCredentials.toList())
        assertEquals(context.getString(R.string.credentials_not_read), awaitAppAlertText())
    }

    @Test
    fun `signing out clears the phone before the controller answers the revoke`() = runTest {
        val graph = buildGraph()
        graph.signIn(controller.origin.toString(), "ada", "right")
        val gate = CountDownLatch(1)
        revokeGate = gate

        val signOut = async { graph.signOut() }
        awaitValue { requests.firstOrNull { it.startsWith("DELETE") } }

        assertNull(credentialStore.read())
        assertNull(graph.openClient(), "a reconnect during the revoke opens nothing")
        assertFalse(graph.restoreSignIn(), "nor does the app opening again")
        gate.countDown()
        assertEquals(SignOutResult(revokeFailure = null), signOut.await())
    }

    @Test
    fun `an API Key that can never be decrypted again is cleared, and the phone is signed out`() = runTest {
        val graph = buildGraph()
        val otherKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        CredentialStore(credentialDataStore) { otherKey }.save(StoredCredentials(controller.origin.toString(), "ada", "k1", "phone-key"))

        assertFalse(graph.restoreSignIn())

        assertFalse(credentialStore.hasCredentials.first())
        assertNull(takeStartedService())
    }

    @Test
    fun `an API Key that can never be decrypted again, and cannot be removed, is kept and the user is told`() = runTest {
        var isDiskFull = false
        val graph = buildGraph(wrapCredentialsFile = { failWritesWhile(it) { isDiskFull } })
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val otherKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        CredentialStore(credentialDataStore) { otherKey }.save(StoredCredentials(controller.origin.toString(), "ada", "k1", "phone-key"))
        isDiskFull = true

        assertFalse(graph.restoreSignIn())

        assertTrue(credentialStore.hasCredentials.first(), "the next read tries again")
        assertEquals(context.getString(R.string.credentials_not_read), awaitAppAlertText())
    }

    @Test
    fun `a sign-in the controller refused is ended, so the connection stops and everything is cleared`() = runTest {
        val graph = buildGraph()
        graph.signIn(controller.origin.toString(), "ada", "right")
        memoryStore.write(AlertMemory(followedSessionId = "s1"))
        val hasCredentials = credentialStore.hasCredentials.stateIn(backgroundScope, SharingStarted.Eagerly, true)

        graph.endRefusedSignIn()

        awaitValue { hasCredentials.value.takeIf { !it } }
        assertEquals(ControllerWatchService::class.java.name, shadowOf(context).nextStoppedService?.component?.className)
        assertNull(memoryStore.read())
        assertFalse(requests.any { it.startsWith("DELETE") }, "nothing is revoked")
    }

    @Test
    fun `an alert pipeline that fails stops the connection and tells the user, and the app starts it again`() = runTest {
        val graph = buildGraph(wrapAlertsFile = { file ->
            object : DataStore<Preferences> by file {
                override val data = flow<Preferences> { throw IOException("the alert memory could not be read") }
            }
        })
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        credentialStore.save(StoredCredentials(controller.origin.toString(), "ada", "k1", "phone-key"))

        graph.openClient()

        assertEquals(context.getString(R.string.alerts_stopped), awaitAppAlertText())
        assertEquals(ControllerWatchService::class.java.name, shadowOf(context).nextStoppedService?.component?.className)
        assertNull(graph.client.value)

        graph.startStoppedControllerWatchService()

        assertEquals(ControllerWatchService::class.java.name, takeStartedService())
    }

    @Test
    fun `coming to the front with credentials that cannot be read keeps them, tells the user, and starts nothing`() = runTest {
        val graph = buildGraph(encryptionKey = { throw KeyStoreException("the Keystore is not ready") })
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        // Saved with a key that works, then read by the graph with a Keystore that does not.
        CredentialStore(credentialDataStore) { aesKey }.save(StoredCredentials(controller.origin.toString(), "ada", "k1", "phone-key"))

        graph.startStoppedControllerWatchService()

        assertNull(takeStartedService())
        assertTrue(credentialStore.hasCredentials.first())
        assertEquals(context.getString(R.string.credentials_not_read), awaitAppAlertText())
    }

    @Test
    fun `keeps only the origin of the address the user typed`() {
        assertEquals("http://mac.tail1234.ts.net:7400/", parseControllerOrigin(" mac.tail1234.ts.net:7400/settings?x=1 ").toString())
        assertEquals("https://hercule.example/", parseControllerOrigin("https://hercule.example").toString())
        assertNull(parseControllerOrigin("ftp://hercule.example"))
        assertNull(parseControllerOrigin(""))
    }
}
