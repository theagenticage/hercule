package dev.hercule.android.service

import android.app.Notification
import android.graphics.Bitmap
import android.os.Looper
import androidx.core.graphics.drawable.IconCompat
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.MainApplication
import dev.hercule.android.alerts.AlertFacePose
import dev.hercule.android.alerts.AlertFaces
import dev.hercule.android.alerts.AlertMemoryStore
import dev.hercule.android.alerts.AlertPoster
import dev.hercule.android.app.AppGraph
import dev.hercule.android.app.BackgroundPermissions
import dev.hercule.android.app.ControllerClient
import dev.hercule.android.controller.MockController
import dev.hercule.android.credentials.CredentialStore
import java.io.File
import java.util.concurrent.TimeUnit
import javax.crypto.KeyGenerator
import kotlin.test.assertEquals
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf

/**
 * Tests the connection service against a mock controller, on Robolectric. The service runs on
 * the main looper, which the test runs by hand, and the graph's files sit in a temporary folder.
 */
@RunWith(AndroidJUnit4::class)
class ConnectionServiceTest {
    @get:Rule val folder = TemporaryFolder()

    private val application: MainApplication = ApplicationProvider.getApplicationContext()
    private val fileScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val controller = MockController { request ->
        when (request.url.encodedPath) {
            "/api/v1/auth/login" -> MockResponse.Builder().body("""{"token":"login-token","expiresAt":"2026-10-20T08:00:00Z"}""").build()
            "/api/v1/api-keys" -> MockResponse.Builder()
                .body("""{"id":"k1","name":"Android - robolectric","token":"phone-key","createdAt":"2026-10-13T08:00:00Z"}""").build()
            else -> MockResponse.Builder().body("""{"items":[]}""").build()
        }
    }

    @After
    fun stop() {
        fileScope.cancel()
        controller.close()
    }

    /** Draws nothing: no test here posts an alert. */
    private val faces = object : AlertFaces {
        private val square = IconCompat.createWithBitmap(Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888))
        override fun drawPersonIcon(seedId: String, isAssistant: Boolean, pose: AlertFacePose) = square
        override fun drawTrackerIcon(sessionId: String, pose: AlertFacePose) = square
        override fun readHueColor(sessionId: String) = 0
    }

    /** Builds a graph on DataStore files in the temporary folder and makes it the app's graph. */
    private fun installGraph(): AppGraph {
        fun openDataStore(name: String) = PreferenceDataStoreFactory.create(scope = fileScope) { File(folder.root, "$name.preferences_pb") }
        val aesKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val graph = AppGraph(
            application,
            CredentialStore(openDataStore("credentials")) { aesKey },
            AlertMemoryStore(openDataStore("alerts")),
            AlertPoster(application, faces),
            OkHttpClient(),
            BackgroundPermissions(application, openDataStore("background_permissions")),
        )
        application.graph = graph
        return graph
    }

    /** Runs the main looper until [graph] holds an open client, waiting up to 5 s of real time, and returns it. */
    private fun awaitOpenClient(graph: AppGraph): ControllerClient {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (true) {
            shadowOf(Looper.getMainLooper()).idle()
            graph.client.value?.let { return it }
            check(System.nanoTime() < deadline) { "No client opened within 5 s." }
            Thread.sleep(5)
        }
    }

    @Test
    fun `a start after the client was closed opens a new client, instead of waiting on the closed one`() {
        val graph = installGraph()
        runBlocking { graph.signIn(controller.origin.toString(), "ada", "right") }
        val service = Robolectric.buildService(ConnectionService::class.java).create().startCommand(0, 1)
        val first = awaitOpenClient(graph)

        // As a sign-in while the service runs does: it closes the client, then starts the service.
        runBlocking { graph.closeClient() }
        service.startCommand(0, 2)

        assertNotSame(first, awaitOpenClient(graph))
        service.destroy()
    }

    @Test
    fun `the ongoing notification shows where the connection stands as its title, with no text under it`() {
        val graph = installGraph()
        runBlocking { graph.signIn(controller.origin.toString(), "ada", "right") }
        val service = Robolectric.buildService(ConnectionService::class.java).create().startCommand(0, 1)

        val extras = shadowOf(service.get()).lastForegroundNotification.extras
        assertEquals("Connecting…", extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
        assertNull(extras.getCharSequence(Notification.EXTRA_TEXT))
        service.destroy()
    }
}
