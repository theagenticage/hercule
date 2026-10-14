package dev.hercule.android.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.fixtures.buildBookOfficeState
import dev.hercule.android.ui.office.OfficeScreen
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Draws the Office of the book's office.html at the book's phone size, light and dark, and
 * once at 200% font scale, where the tab bar must grow instead of cutting its labels off.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OfficeScreenTest {
    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsOfficeInWhitehaven() = captureScreen(dark = false) { OfficeScreen(buildBookOfficeState(), onOpen = {}, onDecide = { _, _ -> }, onSelectTab = {}) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsOfficeInOrientExpress() = captureScreen(dark = true) { OfficeScreen(buildBookOfficeState(), onOpen = {}, onDecide = { _, _ -> }, onSelectTab = {}) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsOfficeAtDoubleFontScale() = captureScreen(dark = false) {
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 2f)) {
            OfficeScreen(buildBookOfficeState(), onOpen = {}, onDecide = { _, _ -> }, onSelectTab = {})
        }
    }
}
