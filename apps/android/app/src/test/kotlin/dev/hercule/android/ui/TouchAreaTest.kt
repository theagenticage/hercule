package dev.hercule.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.assistant.AssistantScreen
import dev.hercule.android.ui.assistant.SpeechInput
import dev.hercule.android.ui.fixtures.buildBookAssistantState
import dev.hercule.android.ui.fixtures.buildBookThreadState
import dev.hercule.android.ui.thread.ThreadScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Checks that every control drawn smaller than 48 dp keeps its drawn size and still has a 48 dp
 * touch area, as spec 18 §Accessibility asks: a tap just outside the drawn edge, but inside the
 * 48 dp square centred on the control, acts as a tap on the control, and TalkBack reports the
 * control 48 dp wide and tall.
 *
 * Compose extends the touch area and the accessibility bounds of every node that takes pointer
 * input up to `ViewConfiguration.minimumTouchTargetSize`, which is 48 dp, without changing layout
 * or drawing; a few controls, such as the back button, are laid out 48 dp tall instead. These
 * tests hold the small controls to that:
 *
 * - the shared buttons are drawn alone, and each test first checks the drawn size, so a test
 *   whose tap lands inside the drawing fails instead of passing for the wrong reason;
 * - Send, the mic and the work divider are drawn in their real screens, so a clipping parent or
 *   a neighbour taking the tap there fails too.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
class TouchAreaTest {
    @get:Rule
    val compose = createComposeRule()

    private var clicks = 0

    @Test
    fun iconButtonClicksJustOutsideItsDrawnEdge() {
        drawCentred { IconButton(BureauIcons.Plus, "Attach", onClick = { clicks++ }) }
        assertDrawnSize(compose.onNodeWithContentDescription("Attach"), DpSize(28.dp, 28.dp))
        // Drawn 28 dp wide, so its edge is 14 dp from the centre; the touch area reaches 24 dp.
        tapAt(CENTRE + 20.dp, CENTRE)
        assertEquals(1, clicks)
        assertTouchArea48(compose.onNodeWithContentDescription("Attach"))
    }

    @Test
    fun disabledIconButtonHasATouchAreaButDoesNotClick() {
        drawCentred { IconButton(BureauIcons.Plus, "Attach", onClick = { clicks++ }, enabled = false) }
        tapAt(CENTRE + 20.dp, CENTRE)
        tapAt(CENTRE, CENTRE)
        assertEquals(0, clicks)
        assertTouchArea48(compose.onNodeWithContentDescription("Attach"))
    }

    @Test
    fun textFieldIsDrawn44TallAndTouched48Tall() {
        drawCentred { BureauTextField("", {}, "Password", Modifier.size(200.dp, 44.dp)) }
        val field = compose.onNodeWithContentDescription("Password")
        assertEquals(44.dp, field.measureDrawnSize().height)
        assertEquals(48.dp, field.measureTouchArea().height)
    }

    @Test
    fun smallButtonClicksJustOutsideItsDrawnEdge() {
        drawCentred { BureauButton("Edit", onClick = { clicks++ }, size = ButtonSize.Small) }
        assertEquals(26.dp, compose.onNodeWithText("Edit").measureDrawnSize().height)
        // Drawn 26 dp tall, so its edge is 13 dp below the centre; the touch area reaches 24 dp.
        tapAt(CENTRE, CENTRE + 20.dp)
        assertEquals(1, clicks)
        assertTouchArea48(compose.onNodeWithText("Edit"))
    }

    @Test
    fun disabledSmallButtonHasATouchAreaButDoesNotClick() {
        drawCentred { BureauButton("Edit", onClick = { clicks++ }, size = ButtonSize.Small, enabled = false) }
        tapAt(CENTRE, CENTRE + 20.dp)
        tapAt(CENTRE, CENTRE)
        assertEquals(0, clicks)
        assertTouchArea48(compose.onNodeWithText("Edit"))
    }

    @Test
    fun largeButtonClicksJustOutsideItsDrawnEdge() {
        compose.setContent {
            BureauTheme(dark = false) {
                BureauButton("Sign in", onClick = { clicks++ }, modifier = Modifier.fillMaxWidth().padding(top = 100.dp), size = ButtonSize.Large)
            }
        }
        assertEquals(46.dp, compose.onNodeWithText("Sign in").measureDrawnSize().height)
        // Drawn 46 dp tall from 100 dp down, so the touch area starts 1 dp above it.
        tapAt(200.dp, 99.5.dp)
        assertEquals(1, clicks)
        assertEquals(48.dp, compose.onNodeWithText("Sign in").measureTouchArea().height)
    }

    @Test
    fun roundButtonClicksOutsideItsCircle() {
        drawCentred { RoundButton(BureauIcons.Send, "Send", onClick = { clicks++ }) }
        assertDrawnSize(compose.onNodeWithContentDescription("Send"), DpSize(44.dp, 44.dp))
        // Inside the corner of the 44 dp square, outside the circle drawn in it.
        tapAt(CENTRE + 21.dp, CENTRE + 21.dp)
        // Beside the circle, outside the 44 dp square.
        tapAt(CENTRE + 23.dp, CENTRE)
        assertEquals(2, clicks)
        assertTouchArea48(compose.onNodeWithContentDescription("Send"))
    }

    @Test
    fun sendClicksInTheGapBeforeTheField() {
        compose.setContent {
            BureauTheme(dark = false) { Composer("Message Ada…", onSend = { _, _ -> clicks++ }) }
        }
        compose.onNodeWithContentDescription("Message Ada…").performTextInput("Hello")
        val send = compose.onNodeWithContentDescription("Send")
        val drawn = send.fetchSemanticsNode().boundsInRoot
        // The composer leaves a 4 dp gap between the field and Send; a tap in it sends.
        compose.onRoot().performTouchInput { click(Offset(drawn.left - 2.dp.toPx(), drawn.center.y)) }
        assertEquals(1, clicks)
        assertTouchArea48(send)
    }

    @Test
    fun micListensWhenPressedJustOutsideItsDrawnEdge() {
        var starts = 0
        val input = object : SpeechInput {
            override fun start(onResult: (text: String?) -> Unit) {
                starts++
            }

            override fun stop() = Unit
        }
        compose.setContent {
            BureauTheme(dark = false) {
                AssistantScreen(buildBookAssistantState(), onBack = {}, onSend = { _, _ -> }, onDecide = { _, _ -> }, onAnswer = { _, _ -> }, speechInput = input)
            }
        }
        val mic = compose.onNodeWithContentDescription("Hold to talk", substring = true)
        val drawn = mic.fetchSemanticsNode().boundsInRoot
        // Drawn 44 dp wide; 2 dp past its right edge is inside its 48 dp touch area.
        compose.onRoot().performTouchInput { click(Offset(drawn.right + 2.dp.toPx(), drawn.center.y)) }
        assertEquals(1, starts)
        assertTouchArea48(mic)
    }

    @Test
    fun workDividerIsDrawnOneLineTallAndTouched48Tall() {
        compose.setContent {
            BureauTheme(dark = false) { ThreadScreen(buildBookThreadState(), onBack = {}, backLabel = "Back to the Office", onDecide = { _, _ -> }, onAnswer = { _, _ -> }, onSend = { _, _ -> }) }
        }
        val divider = compose.onAllNodesWithText("Worked for", substring = true)[0]
        assertTrue(divider.fetchSemanticsNode().boundsInRoot.height < with(compose.density) { 48.dp.toPx() })
        assertEquals(48.dp, divider.measureTouchArea().height)
    }

    /** Draws [content] centred in a 200 dp square at the top left of the window. */
    private fun drawCentred(content: @Composable () -> Unit) {
        compose.setContent {
            BureauTheme(dark = false) {
                Box(Modifier.size(CENTRE * 2), contentAlignment = Alignment.Center) { content() }
            }
        }
    }

    /** Taps the window at ([x], [y]), measured from its top left. */
    private fun tapAt(x: Dp, y: Dp) {
        compose.onRoot().performTouchInput { click(Offset(x.toPx(), y.toPx())) }
    }

    /** Checks that the node is drawn [size] in dp. */
    private fun assertDrawnSize(node: SemanticsNodeInteraction, size: DpSize) {
        assertEquals(size, node.measureDrawnSize())
    }

    /** Returns the size the node is drawn at, in dp. */
    private fun SemanticsNodeInteraction.measureDrawnSize(): DpSize {
        val bounds: Rect = fetchSemanticsNode().boundsInRoot
        return with(compose.density) { DpSize(bounds.width.toDp(), bounds.height.toDp()) }
    }

    /** Checks that the node's touch area is 48 dp square. */
    private fun assertTouchArea48(node: SemanticsNodeInteraction) {
        val area = node.measureTouchArea()
        assertEquals(48.dp, area.width)
        assertEquals(48.dp, area.height)
    }

    /**
     * Returns the size of the node's touch area in dp. The accessibility service gets these
     * bounds for the node too, so this is also the size TalkBack reports.
     */
    private fun SemanticsNodeInteraction.measureTouchArea(): DpSize {
        val bounds: Rect = fetchSemanticsNode().touchBoundsInRoot
        return with(compose.density) { DpSize(bounds.width.toDp(), bounds.height.toDp()) }
    }

    private companion object {
        val CENTRE = 100.dp
    }
}
