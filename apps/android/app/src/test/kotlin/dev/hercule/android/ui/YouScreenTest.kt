package dev.hercule.android.ui

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.you.YouScreen
import dev.hercule.android.ui.you.Licence
import dev.hercule.android.ui.fixtures.buildBookYouState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Draws the You screen, signed in and connected, with the One UI note, light and dark. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class YouScreenTest {
    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsYouInWhitehaven() = captureScreen(dark = false) { YouScreen(buildBookYouState(LICENCES), onSignOut = {}, onSelectTab = {}) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsYouInOrientExpress() = captureScreen(dark = true) { YouScreen(buildBookYouState(LICENCES), onSignOut = {}, onSelectTab = {}) }
}

private val LICENCES = listOf(
    Licence("Bricolage Grotesque", "SIL Open Font License 1.1"),
    Licence("Limelight", "SIL Open Font License 1.1"),
    Licence("Recursive", "SIL Open Font License 1.1"),
    Licence("commonmark-java", "BSD 2-Clause License"),
    Licence("marked", "MIT License"),
)
