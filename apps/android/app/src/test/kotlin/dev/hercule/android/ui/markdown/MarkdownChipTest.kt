package dev.hercule.android.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.Dp
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
 * Draws inline code chips where their padding is hardest to make room for, as the padding holds
 * no character (see makeRoomForChips), at three font scales and at a narrow width; and the
 * streaming caret after mixed-direction text.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MarkdownChipTest {
    @Test
    @Config(qualifiers = "w320dp-h1400dp-xhdpi")
    fun drawsChipsInWhitehaven() = drawChips(288.dp)

    @Test
    @Config(qualifiers = "w320dp-h1800dp-xhdpi", fontScale = 1.5f)
    fun drawsChipsAtOneAndAHalfFontScale() = drawChips(288.dp)

    @Test
    @Config(qualifiers = "w320dp-h2400dp-xhdpi", fontScale = 2f)
    fun drawsChipsAtDoubleFontScale() = drawChips(288.dp)

    @Test
    @Config(qualifiers = "w200dp-h2000dp-xhdpi")
    fun drawsChipsInANarrowColumn() = drawChips(168.dp)

    @Test
    @Config(qualifiers = "w320dp-h400dp-xhdpi")
    fun drawsTheCaretAfterTheLastCharacterOfMixedText() = captureRoboImage {
        Sheet(288.dp) {
            MessageMarkdown("Hebrew in a left-to-right screen: שלום עולם", MessageAuthor.Agent, writing = true, caret = bureauColors.accent)
            MessageMarkdown("שלום עולם, and it ends in English", MessageAuthor.Agent, writing = true, caret = bureauColors.accent)
            MessageMarkdown("שלום `git push` עולם", MessageAuthor.Agent, writing = true, caret = bureauColors.accent)
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                MessageMarkdown("שלום עולם", MessageAuthor.Agent, writing = true, caret = bureauColors.accent)
            }
        }
    }

    private fun drawChips(width: Dp) = captureRoboImage {
        Sheet(width) {
            CHIP_CASES.forEach { MessageMarkdown(it, MessageAuthor.Agent) }
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) { MessageMarkdown("שלום `git push` עולם", MessageAuthor.Agent) }
        }
    }
}

@Composable
private fun Sheet(width: Dp, content: @Composable () -> Unit) = BureauTheme(dark = false) {
    Column(Modifier.background(bureauColors.surface).padding(16.dp).width(width), verticalArrangement = Arrangement.spacedBy(14.dp)) { content() }
}

private val CHIP_CASES = listOf(
    "`git push` starts the line.",
    "Run `git push`, then `pnpm test`.",
    "Call it (`openThreeDSModal`) once.",
    "No space after it: `a`). Or before it: word`b`.",
    "Chips in a row: <code>a</code><code>b</code>, `c`**`d`**, `e` `f` `g`.",
    "Beside marks: `a`[^1], a link [`code`](https://example.com), and <code>c</code><a href=\"https://example.com\">d</a>.\n\n[^1]: The note.",
    "A chip that breaks over two lines: `handlePaymentResult in src/checkout/payment.ts` here.",
    "Long words fill this line so the chip `confirmPayment` starts the next one.",
    "שלום `git push` עולם, ואז `pnpm test`.",
    "Run `git push` in שלום, then `pnpm test`.",
    "Ship it 🚀`deploy` 🇳🇱, and 👩‍💻`x`✔️.",
)
