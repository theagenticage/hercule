package dev.hercule.android.ui.markdown

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.click
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.TextLayoutResult

/**
 * Taps the middle of the first [part] of this text node's text, where a finger on the phone
 * would land on it.
 */
fun SemanticsNodeInteraction.tapOnText(part: String): SemanticsNodeInteraction {
    val results = mutableListOf<TextLayoutResult>()
    fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(results)
    val layout = results.single()
    val start = layout.layoutInput.text.text.indexOf(part)
    check(start >= 0) { "The text has no \"$part\"" }
    val box = layout.getBoundingBox(start + part.length / 2)
    return performTouchInput { click(box.center) }
}
