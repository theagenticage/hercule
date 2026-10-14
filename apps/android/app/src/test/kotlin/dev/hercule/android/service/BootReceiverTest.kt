package dev.hercule.android.service

import android.content.Intent
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
import dev.hercule.android.credentials.CredentialStore
import dev.hercule.android.credentials.StoredCredentials
import java.io.File
import java.security.KeyStoreException
import java.util.concurrent.TimeUnit
import javax.crypto.KeyGenerator
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

@RunWith(AndroidJUnit4::class)
class BootReceiverTest {
    @get:Rule val folder = TemporaryFolder()

    private val application: MainApplication = ApplicationProvider.getApplicationContext()
    private val fileScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After
    fun stop() = fileScope.cancel()

    /** Draws nothing: no test here posts an alert. */
    private val faces = object : AlertFaces {
        private val square = IconCompat.createWithBitmap(Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888))
        override fun drawPersonIcon(seedId: String, isAssistant: Boolean, pose: AlertFacePose) = square
        override fun drawTrackerIcon(sessionId: String, pose: AlertFacePose) = square
        override fun readHueColor(sessionId: String) = 0
    }

    @Test
    fun `starts the watch service after a restart or an update, when signed in`() {
        assertTrue(shouldStartControllerWatchService(Intent.ACTION_BOOT_COMPLETED, isSignedIn = true))
        assertTrue(shouldStartControllerWatchService(Intent.ACTION_MY_PACKAGE_REPLACED, isSignedIn = true))
    }

    @Test
    fun `starts nothing when signed out, or for another broadcast`() {
        assertFalse(shouldStartControllerWatchService(Intent.ACTION_BOOT_COMPLETED, isSignedIn = false))
        assertFalse(shouldStartControllerWatchService(Intent.ACTION_LOCKED_BOOT_COMPLETED, isSignedIn = true))
        assertFalse(shouldStartControllerWatchService(null, isSignedIn = true))
    }

    @Test
    fun `decides on stored credentials without decrypting them, so a Keystore not ready at boot starts the service anyway`() {
        fun openDataStore(name: String) = PreferenceDataStoreFactory.create(scope = fileScope) { File(folder.root, "$name.preferences_pb") }
        val credentialDataStore = openDataStore("credentials")
        val aesKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        runBlocking { CredentialStore(credentialDataStore) { aesKey }.save(StoredCredentials("http://mac:7400/", "ada", "k1", "phone-key")) }
        application.graph = AppGraph(
            application,
            CredentialStore(credentialDataStore) { throw KeyStoreException("the Keystore is not ready") },
            AlertMemoryStore(openDataStore("alerts")),
            AlertPoster(application, faces),
            OkHttpClient(),
            BackgroundPermissions(application, openDataStore("background_permissions")),
        )

        application.sendBroadcast(Intent(Intent.ACTION_BOOT_COMPLETED).setPackage(application.packageName))

        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (true) {
            shadowOf(Looper.getMainLooper()).idle()
            val started = shadowOf(application).nextStartedService
            if (started != null) {
                assertEquals(ControllerWatchService::class.java.name, started.component?.className)
                return
            }
            check(System.nanoTime() < deadline) { "The service was not started within 5 s." }
            Thread.sleep(5)
        }
    }
}
