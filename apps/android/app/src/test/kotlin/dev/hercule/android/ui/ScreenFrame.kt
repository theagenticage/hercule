package dev.hercule.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage

/**
 * Captures [screen] the way the book frames a phone page: in the theme ([dark] or light), with
 * the book's 54 dp status bar above it and a 20 dp gesture bar below it, both left empty.
 *
 * Robolectric reports no system bars, so the screen's own inset padding is zero here; the
 * frame stands in for the bars the phone draws.
 */
fun captureScreen(dark: Boolean, screen: @Composable () -> Unit) = captureRoboImage {
    BureauTheme(dark = dark) {
        Column(Modifier.fillMaxSize().background(bureauColors.bg)) {
            Spacer(Modifier.fillMaxWidth().height(STATUS_BAR_HEIGHT))
            Box(Modifier.weight(1f)) { screen() }
            Spacer(Modifier.fillMaxWidth().height(GESTURE_BAR_HEIGHT))
        }
    }
}

/** The book's status bar, `.status`. */
val STATUS_BAR_HEIGHT = 54.dp

/** Android's gesture bar on the phone, which the book draws as its 34 px home-indicator area. */
val GESTURE_BAR_HEIGHT = 20.dp
