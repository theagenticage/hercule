package dev.hercule.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasNoClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.threads.MessageSender
import dev.hercule.android.threads.SenderLink
import dev.hercule.android.threads.SenderReading
import dev.hercule.android.ui.markdown.MessageAuthor
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Checks the sender chip's drawing, navigation, accessibility and space while its read lands. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UserBubbleSenderTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun drawsSenderInWhitehaven() = captureSender(ADA)

    @Test
    fun drawsSenderInOrientExpress() = captureSender(ADA, dark = true)

    @Test
    fun drawsLongSenderName() = captureSender(LONG_NAME, text = "Done.")

    @Test
    fun drawsAnotherAgent() = captureSender(ANOTHER_AGENT)

    @Test
    fun drawsUnreadSender() = captureSender(MessageSender.Unread)

    @Test
    fun drawsPressedSender() = captureSender(ADA, pressed = true)

    @Test
    fun opensTheAssistantOrThreadNamedByTheChip() {
        var sender by mutableStateOf(ADA)
        val opened = mutableListOf<SenderLink>()
        compose.setContent {
            BureauTheme(dark = false) { UserBubble("Done.", null, MessageAuthor.AnotherAgent, sender = sender, onOpenSender = opened::add) }
        }

        compose.onNodeWithText("Ada").performClick()
        compose.runOnIdle { sender = LONG_NAME }
        compose.onNodeWithText(LONG_NAME.reading.name).performClick()

        assertEquals(listOf(ADA.reading.link, LONG_NAME.reading.link), opened)
    }

    @Test
    fun namesTheMessageWithoutHidingItsWordsAndLeavesAnUnreadableSenderUnclickable() {
        compose.setContent {
            BureauTheme(dark = false) { UserBubble("A readable message.", null, MessageAuthor.AnotherAgent, sender = ANOTHER_AGENT) }
        }

        compose.onNodeWithContentDescription("Message from another agent").assertExists()
        compose.onNodeWithText("A readable message.").assertExists()
        compose.onNodeWithText("Another agent").assert(hasNoClickAction())
    }

    @Test
    fun groupsTheSenderBeforeTheMessageAndTimeForAccessibility() {
        compose.setContent {
            BureauTheme(dark = false) { UserBubble("Done.", "09:04", MessageAuthor.AnotherAgent, sender = ADA) }
        }

        val message = compose.onNodeWithContentDescription("Message from Ada").fetchSemanticsNode()
        assertTrue(message.config[SemanticsProperties.IsTraversalGroup])
        fun readWords(node: SemanticsNode): List<String> = node.config.getOrNull(SemanticsProperties.Text)
            ?.let { listOf(it.joinToString("") { text -> text.text }) } ?: node.children.flatMap(::readWords)
        val words = message.children.flatMap(::readWords)
        assertEquals(listOf("Ada", "Done.", "09:04"), words)
    }

    @Test
    fun keepsTheBubbleInPlaceWhenALongSenderNameArrives() = assertSenderKeepsBubbleBounds()

    @Test
    @Config(fontScale = 2f)
    fun keepsTheBubbleInPlaceAtDoubleFontScale() = assertSenderKeepsBubbleBounds()

    /** Checks that resolving a sender neither moves nor widens its bubble, including its code block. */
    private fun assertSenderKeepsBubbleBounds() {
        var sender: MessageSender by mutableStateOf(MessageSender.Unread)
        compose.setContent {
            BureauTheme(dark = false) {
                UserBubble("Done.\n\n```\nx\n```", "09:04", MessageAuthor.AnotherAgent, sender = sender)
            }
        }
        val text = compose.onNodeWithText("Done.")
        val code = compose.onNodeWithText("x")
        val textBefore = text.getUnclippedBoundsInRoot()
        val codeBefore = code.getUnclippedBoundsInRoot()

        compose.runOnIdle { sender = LONG_NAME }

        assertEquals(textBefore, text.getUnclippedBoundsInRoot())
        assertEquals(codeBefore, code.getUnclippedBoundsInRoot())
        val chip = compose.onNodeWithText(LONG_NAME.reading.name)
        val nameBounds = compose.onNodeWithText(LONG_NAME.reading.name, useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertTrue(nameBounds.right - nameBounds.left + 22.dp <= 240.dp)
        val layouts = mutableListOf<TextLayoutResult>()
        chip.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertTrue(layouts.single().isLineEllipsized(0))
        compose.onNodeWithContentDescription("Message from ${LONG_NAME.reading.label}").assertExists()
    }

    /** Captures a sender's bubble beside the user's neutral bubble, so their tint can be compared. */
    private fun captureSender(sender: MessageSender, dark: Boolean = false, text: String = "I checked `checkout.ts`. Ready to ship.", pressed: Boolean = false) {
        compose.setContent {
            BureauTheme(dark = dark) {
                Column(Modifier.fillMaxWidth().background(bureauColors.surface).padding(16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    UserBubble("Please check the checkout.", "09:02", MessageAuthor.User)
                    UserBubble(text, "09:04", MessageAuthor.AnotherAgent, sender = sender)
                }
            }
        }
        if (pressed) {
            compose.mainClock.autoAdvance = false
            compose.onNodeWithText("Ada").performTouchInput { down(center) }
            compose.mainClock.advanceTimeBy(300)
        }
        compose.onRoot().captureRoboImage()
        if (pressed) compose.onNodeWithText("Ada").performTouchInput { up() }
    }
}

private val ADA = MessageSender.Agent(SenderReading("Ada", "Ada", OfficeFace("ada", Pose.Idle, isAssistant = true), SenderLink.Assistant("ada")))
private val LONG_NAME = MessageSender.Agent(
    SenderReading(
        "Review every checkout edge case before the release goes out",
        "Review every checkout edge case before the release goes out",
        OfficeFace("checkout", Pose.Idle, isAssistant = false),
        SenderLink.Thread("checkout"),
    ),
)
private val ANOTHER_AGENT = MessageSender.Agent(SenderReading("Another agent", "another agent", OfficeFace("missing", Pose.Idle, isAssistant = false), SenderLink.None))
