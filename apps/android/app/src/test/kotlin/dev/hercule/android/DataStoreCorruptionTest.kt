package dev.hercule.android

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.alerts.openAlertMemoryStore
import dev.hercule.android.app.openBackgroundPermissions
import dev.hercule.android.credentials.openCredentialStore
import java.io.File
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Checks that the app's three DataStore files read as empty when they are damaged, such as
 * after a write the phone cut off, instead of failing every read and crashing at each start.
 */
@RunWith(AndroidJUnit4::class)
class DataStoreCorruptionTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    /** Writes bytes that are no Preferences file to the DataStore file [name]. */
    private fun damageFile(name: String) {
        File(context.filesDir, "datastore/$name.preferences_pb").apply { parentFile!!.mkdirs() }.writeText("not a preferences file")
    }

    @Test
    fun `damaged credentials read as signed out`() = runTest {
        damageFile("credentials")
        assertFalse(openCredentialStore(context).hasCredentials.first())
    }

    @Test
    fun `a damaged alert memory reads as none stored`() = runTest {
        damageFile("alerts")
        assertNull(openAlertMemoryStore(context).read())
    }

    @Test
    fun `damaged background permissions read as never asked`() = runTest {
        damageFile("background_permissions")
        assertTrue(openBackgroundPermissions(context).shouldAskBatteryExemption())
    }
}
