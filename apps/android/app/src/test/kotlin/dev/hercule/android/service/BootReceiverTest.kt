package dev.hercule.android.service

import android.content.Intent
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

class BootReceiverTest {
    @Test
    fun `starts the watch service after a restart or an update, when signed in`() {
        assertTrue(shouldStartWatchService(Intent.ACTION_BOOT_COMPLETED, isSignedIn = true))
        assertTrue(shouldStartWatchService(Intent.ACTION_MY_PACKAGE_REPLACED, isSignedIn = true))
    }

    @Test
    fun `starts nothing when signed out, or for another broadcast`() {
        assertFalse(shouldStartWatchService(Intent.ACTION_BOOT_COMPLETED, isSignedIn = false))
        assertFalse(shouldStartWatchService(Intent.ACTION_LOCKED_BOOT_COMPLETED, isSignedIn = true))
        assertFalse(shouldStartWatchService(null, isSignedIn = true))
    }
}
