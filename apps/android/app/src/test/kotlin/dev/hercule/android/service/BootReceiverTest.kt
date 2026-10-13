package dev.hercule.android.service

import android.content.Intent
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

class BootReceiverTest {
    @Test
    fun `starts the connection after a restart or an update, when signed in`() {
        assertTrue(shouldStartConnection(Intent.ACTION_BOOT_COMPLETED, isSignedIn = true))
        assertTrue(shouldStartConnection(Intent.ACTION_MY_PACKAGE_REPLACED, isSignedIn = true))
    }

    @Test
    fun `starts nothing when signed out, or for another broadcast`() {
        assertFalse(shouldStartConnection(Intent.ACTION_BOOT_COMPLETED, isSignedIn = false))
        assertFalse(shouldStartConnection(Intent.ACTION_LOCKED_BOOT_COMPLETED, isSignedIn = true))
        assertFalse(shouldStartConnection(null, isSignedIn = true))
    }
}
