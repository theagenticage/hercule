package dev.hercule.android.ui

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.connection.ConnectionScreen
import dev.hercule.android.ui.connection.FontLicence
import dev.hercule.android.ui.fixtures.buildBookConnectionState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Draws the You screen, signed in and connected, with the One UI note, light and dark. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConnectionScreenTest {
    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsConnectionInWhitehaven() = captureScreen(dark = false) { ConnectionScreen(buildBookConnectionState(LICENCES), onSignOut = {}, onSelectTab = {}) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsConnectionInOrientExpress() = captureScreen(dark = true) { ConnectionScreen(buildBookConnectionState(LICENCES), onSignOut = {}, onSelectTab = {}) }
}

private val LICENCES = listOf(
    FontLicence("Bricolage Grotesque", "SIL Open Font License 1.1"),
    FontLicence("Limelight", "SIL Open Font License 1.1"),
    FontLicence("Recursive", "SIL Open Font License 1.1"),
)
