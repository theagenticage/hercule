package dev.hercule.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.theme.DecoFontFamily
import dev.hercule.android.theme.MonoFontFamily
import dev.hercule.android.theme.RegularWeight
import dev.hercule.android.theme.UiFontFamily
import org.junit.Test
import kotlin.test.assertEquals
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Proves the build stack end to end: Compose renders on Robolectric's native graphics, a
 * Display P3 colour reaches the canvas, and the bundled fonts load with their variable axes.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class StackProofTest {
    @Test
    fun convertsDisplayP3ColourToSrgbByClipping() {
        // The P3 green lies outside sRGB, so converting it clips the red channel to zero.
        val srgb = Color(0.2f, 0.8f, 0.3f, 1f, ColorSpaces.DisplayP3).convert(ColorSpaces.Srgb)
        assertEquals(0f, srgb.red)
    }

    @Test
    fun drawsDisplayP3ColourAndBundledFonts() {
        captureRoboImage {
            Column(Modifier.background(Color.White).padding(16.dp)) {
                Row {
                    Box(Modifier.size(48.dp).background(Color(0.2f, 0.8f, 0.3f, 1f, ColorSpaces.DisplayP3)))
                    Box(Modifier.size(48.dp).background(Color(0.2f, 0.8f, 0.3f, 1f, ColorSpaces.Srgb)))
                }
                Text("Hercule", fontFamily = DecoFontFamily, fontSize = 32.sp)
                Text("Fix 3-D Secure checkout", fontFamily = UiFontFamily, fontWeight = RegularWeight, fontSize = 16.sp)
                Text("Fix 3-D Secure checkout", fontFamily = UiFontFamily, fontWeight = BoldWeight, fontSize = 16.sp)
                Text("git push -u origin fix/3ds-eu-cards", fontFamily = MonoFontFamily, fontSize = 14.sp)
            }
        }
    }
}
