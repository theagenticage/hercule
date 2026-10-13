package dev.hercule.android.ui

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.fixtures.buildBookOfficeState
import dev.hercule.android.ui.office.OfficeScreen
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Draws the Office of the book's office.html at the book's phone size, light and dark. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OfficeScreenTest {
    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsOfficeInWhitehaven() = captureScreen(dark = false) { OfficeScreen(buildBookOfficeState(), onOpen = {}, onDecide = { _, _ -> }, onSelectTab = {}) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsOfficeInOrientExpress() = captureScreen(dark = true) { OfficeScreen(buildBookOfficeState(), onOpen = {}, onDecide = { _, _ -> }, onSelectTab = {}) }
}
