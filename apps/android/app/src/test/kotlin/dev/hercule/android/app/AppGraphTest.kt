package dev.hercule.android.app

import android.app.Application
import android.graphics.Bitmap
import androidx.core.graphics.drawable.IconCompat
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.alerts.AlertFacePose
import dev.hercule.android.alerts.AlertFaces
import dev.hercule.android.alerts.AlertMemory
import dev.hercule.android.alerts.AlertMemoryStore
import dev.hercule.android.alerts.AlertPoster
import dev.hercule.android.controller.MockController
import dev.hercule.android.credentials.CredentialStore
import dev.hercule.android.credentials.StoredCredentials
import dev.hercule.android.service.ConnectionService
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import javax.crypto.KeyGenerator
import kotlin.test.assertEquals
import kotlin.test.assertNull
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
            "/api/v1/api-keys" -> MockResponse.Builder()
                .body("""{"id":"k1","name":"Android - robolectric","token":"phone-key","createdAt":"2026-10-13T08:00:00Z"}""").build()
            "/api/v1/api-keys/k1" -> revokeReply
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

    private lateinit var credentialStore: CredentialStore
    private lateinit var memoryStore: AlertMemoryStore

    private fun TestScope.buildGraph(): AppGraph {
        fun openDataStore(name: String) = PreferenceDataStoreFactory.create(scope = backgroundScope) { File(folder.root, "$name.preferences_pb") }
        credentialStore = CredentialStore(openDataStore("credentials")) { aesKey }
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
    fun `signs in with a new API Key, throws the login token away, and starts the connection`() = runTest {
        val graph = buildGraph()
        memoryStore.write(AlertMemory(followedSessionId = "s-from-before"))

        val result = graph.signIn(controller.origin.toString().removePrefix("http://"), "ada", "right")

        assertEquals(SignInResult.SignedIn, result)
        assertEquals(StoredCredentials(controller.origin.toString(), "ada", "k1", "phone-key"), credentialStore.read())
        assertEquals(listOf("POST /api/v1/auth/login null", "POST /api/v1/api-keys login-token"), requests.toList())
        assertNull(memoryStore.read(), "the next list is a first list")
        assertEquals(ConnectionService::class.java.name, takeStartedService())
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
    fun `an address that is not a URL, or that nothing answers at, is reported`() = runTest {
        val graph = buildGraph()
        assertEquals(SignInResult.BadUrl, graph.signIn("not a url", "ada", "right"))
        val origin = controller.origin.toString()
        controller.close()
        assertEquals(SignInResult.Unreachable, graph.signIn(origin, "ada", "right"))
    }

    @Test
    fun `signs out by stopping the connection, revoking the key, and clearing everything`() = runTest {
        val graph = buildGraph()
        graph.signIn(controller.origin.toString(), "ada", "right")
        memoryStore.write(AlertMemory(followedSessionId = "s1"))
        requests.clear()

        val result = graph.signOut()

        assertEquals(SignOutResult(revokeFailure = null), result)
        assertEquals(listOf("DELETE /api/v1/api-keys/k1 phone-key"), requests.toList())
        assertEquals(ConnectionService::class.java.name, shadowOf(context).nextStoppedService?.component?.className)
        assertNull(credentialStore.read())
        assertNull(memoryStore.read())
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
    fun `keeps only the origin of the address the user typed`() {
        assertEquals("http://mac.tail1234.ts.net:7400/", parseControllerOrigin(" mac.tail1234.ts.net:7400/settings?x=1 ").toString())
        assertEquals("https://hercule.example/", parseControllerOrigin("https://hercule.example").toString())
        assertNull(parseControllerOrigin("ftp://hercule.example"))
        assertNull(parseControllerOrigin(""))
    }
}
