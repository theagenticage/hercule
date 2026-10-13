package dev.hercule.android.app

import android.app.Application
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.IOException
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith

/** Tests [BackgroundPermissions] on a stored file that can be neither read nor written. */
@RunWith(AndroidJUnit4::class)
class BackgroundPermissionsTest {
    private val context: Application = ApplicationProvider.getApplicationContext()

    private val brokenFile = object : DataStore<Preferences> {
        override val data: Flow<Preferences> = flow { throw IOException("the file could not be read") }
        override suspend fun updateData(transform: suspend (Preferences) -> Preferences): Preferences =
            throw IOException("the disk is full")
    }

    @Test
    fun `asks the battery question when the file cannot be read, and records it without failing`() = runTest {
        val permissions = BackgroundPermissions(context, brokenFile)

        assertTrue(permissions.shouldAskBatteryExemption())
        permissions.recordBatteryExemptionAsked()
    }
}
