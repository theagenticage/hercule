package dev.hercule.android.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import dev.hercule.android.ui.fixtures.buildBookOfficeState
import dev.hercule.android.ui.fixtures.buildBookThreadState
import dev.hercule.android.ui.office.OfficeScreen
import dev.hercule.android.ui.thread.ThreadScreen
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Draws the Office and the Fix thread in landscape, with a camera cutout on the left and the
 * navigation bar on the right, as a phone turned on its side has them. Every part of a screen
 * keeps clear of both by the same amount, while the backgrounds reach the screen's edges.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LandscapeScreenTest {
    @Test
    @Config(qualifiers = "w844dp-h390dp-land-xhdpi")
    fun drawsOfficeBesideACutout() = captureBesideCutout { OfficeScreen(buildBookOfficeState(), onOpen = {}, onDecide = { _, _ -> }, onSelectTab = {}) }

    @Test
    @Config(qualifiers = "w844dp-h390dp-land-xhdpi")
    fun drawsThreadBesideACutout() =
        captureBesideCutout { ThreadScreen(buildBookThreadState(), onBack = {}, backLabel = "Back to the Office", onDecide = { _, _ -> }, onAnswer = { _, _ -> }, onSend = { _, _ -> }) }

    /**
     * Captures [screen] drawn edge to edge in an activity, after handing the activity a cutout
     * and system bars of a phone's sizes. Robolectric reports no insets of its own, and
     * [captureScreen]'s frame only stands in for the bars without passing any insets.
     */
    private fun captureBesideCutout(screen: @Composable () -> Unit) {
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.enableEdgeToEdge()
                activity.setContent { BureauTheme(dark = false) { screen() } }
            }
            scenario.onActivity { activity ->
                val insets = WindowInsetsCompat.Builder()
                    .setInsets(WindowInsetsCompat.Type.displayCutout(), Insets.of(CUTOUT_PX, 0, 0, 0))
                    .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, STATUS_BAR_PX, 0, 0))
                    .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, NAVIGATION_BAR_PX, 0))
                    .build()
                ViewCompat.dispatchApplyWindowInsets(activity.window.decorView, insets)
            }
            shadowOf(Looper.getMainLooper()).idle()
            scenario.onActivity { it.window.decorView.captureRoboImage() }
        }
    }

    private companion object {
        // At xhdpi, 2 px to the dp: a 56 dp cutout, a 24 dp status bar and a 48 dp button bar.
        const val CUTOUT_PX = 112
        const val STATUS_BAR_PX = 48
        const val NAVIGATION_BAR_PX = 96
    }
}
