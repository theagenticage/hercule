package dev.hercule.android.app

import android.app.Application
import android.graphics.Bitmap
import androidx.core.graphics.drawable.IconCompat
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
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
import java.security.KeyStoreException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
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
            "/api/v1/auth/logout" -> logoutReply
            "/api/v1/api-keys" -> createApiKeyReply
            "/api/v1/api-keys/k1" -> {
                revokeGate?.await(5, TimeUnit.SECONDS)
                revokeReply
            }
            else -> MockResponse.Builder().code(404).build()
        }
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

    /** Builds the graph on DataStore files in a temporary folder, its API Keys encrypted under [encryptionKey]. */
    private fun TestScope.buildGraph(encryptionKey: () -> SecretKey = { aesKey }): AppGraph {
        fun openDataStore(name: String) = PreferenceDataStoreFactory.create(scope = backgroundScope) { File(folder.root, "$name.preferences_pb") }
        credentialDataStore = openDataStore("credentials")
        credentialStore = CredentialStore(credentialDataStore, encryptionKey)
        memoryStore = AlertMemoryStore(openDataStore("alerts"))
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
        val graph = buildGraph { throw KeyStoreException("the Keystore is not ready") }

        val result = graph.signIn(controller.origin.toString(), "ada", "right")

        assertEquals(SignInResult.NotStored, result)
        assertEquals("DELETE /api/v1/api-keys/k1 phone-key", requests.last())
        assertFalse(credentialStore.hasCredentials.first())
        assertNull(takeStartedService())
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
    fun `keeps only the origin of the address the user typed`() {
        assertEquals("http://mac.tail1234.ts.net:7400/", parseControllerOrigin(" mac.tail1234.ts.net:7400/settings?x=1 ").toString())
        assertEquals("https://hercule.example/", parseControllerOrigin("https://hercule.example").toString())
        assertNull(parseControllerOrigin("ftp://hercule.example"))
        assertNull(parseControllerOrigin(""))
    }
}
