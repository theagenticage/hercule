package dev.hercule.android.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import dev.hercule.android.ui.BureauTheme
import dev.hercule.android.ui.bureauColors
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Draws inline code chips in the places their padding is hardest to make room for, as the
 * padding holds no character (see makeRoomForChips): at the start of a message, before a comma,
 * in brackets, broken over two lines, at the start of a wrapped line, and in right-to-left text.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w320dp-h620dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MarkdownChipTest {
    @Test
    fun drawsChipsInWhitehaven() = captureRoboImage {
        BureauTheme(dark = false) {
            Column(Modifier.background(bureauColors.surface).padding(16.dp).width(288.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                listOf(
                    "`git push` starts the line.",
                    "Run `git push`, then `pnpm test`.",
                    "Call it (`openThreeDSModal`) once.",
                    "A chip that breaks over two lines: `handlePaymentResult in src/checkout/payment.ts` here.",
                    "Long words fill this line so the chip `confirmPayment` starts the next one.",
                ).forEach { MessageMarkdown(it, MessageAuthor.Agent) }
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) { MessageMarkdown("שלום `git push` עולם", MessageAuthor.Agent) }
            }
        }
    }
}
