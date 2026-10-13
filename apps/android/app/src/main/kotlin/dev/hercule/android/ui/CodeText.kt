package dev.hercule.android.ui

import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import dev.hercule.android.theme.MonoFontFamily

/**
 * One run of a line of text: plain prose, or code that the text wrote between backticks.
 */
data class TextRun(val text: String, val isCode: Boolean)

/**
 * Splits [text] into prose and code at its backticks, as Markdown writes inline code:
 * "Run `git push`?" becomes "Run ", the code "git push", and "?". A backtick with no partner
 * is kept as an ordinary character, and empty runs are dropped.
 */
fun splitInlineCode(text: String): List<TextRun> {
    val runs = mutableListOf<TextRun>()
    var rest = text
    while (rest.isNotEmpty()) {
        val open = rest.indexOf('`')
        val close = if (open < 0) -1 else rest.indexOf('`', open + 1)
        if (close < 0) {
            runs += TextRun(rest, isCode = false)
            break
        }
        if (open > 0) runs += TextRun(rest.substring(0, open), isCode = false)
        if (close > open + 1) runs += TextRun(rest.substring(open + 1, close), isCode = true)
        rest = rest.substring(close + 1)
    }
    return runs
}

/**
 * How [CodeText] draws code: in Recursive at [size], in [color], on a rounded [background] with
 * [padding] on each side, or on nothing when [background] is null.
 */
data class InlineCodeStyle(
    val size: TextUnit,
    val color: Color,
    val background: Color? = null,
    val padding: Dp = 0.dp,
    val radius: Dp = 0.dp,
)

/**
 * Draws [runs] as one paragraph in [style], with each code run in [codeStyle]: the book's prose
 * with `<code>` inside it.
 *
 * Compose has no rounded background for a span, so the code's background is drawn behind the
 * text from the laid-out positions of the code's characters. The padding is a no-break space on
 * each side of the code, sized to [InlineCodeStyle.padding], so the padding takes room in the line
 * as a CSS padding does.
 */
@Composable
fun CodeText(
    runs: List<TextRun>,
    style: TextStyle,
    codeStyle: InlineCodeStyle,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
) {
    val density = LocalDensity.current
    // Recursive's monospaced advance is 0.6 em wide, so a space of padding / 0.6 fills the padding.
    val paddingSize = with(density) { (codeStyle.padding.toPx() / 0.6f).toSp() }
    val text = remember(runs, codeStyle, paddingSize) { buildCodeString(runs, codeStyle, paddingSize) }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val background = codeStyle.background
    val drawn = if (background == null) {
        modifier
    } else {
        modifier.drawBehind {
            val result = layout ?: return@drawBehind
            val radius = CornerRadius(codeStyle.radius.toPx())
            // The box is the code's em box with 1 dp above and below, as the book's `padding: 1px 5px`.
            val halfHeight = codeStyle.size.toPx() * 0.62f + 1.dp.toPx()
            text.getStringAnnotations(CODE_TAG, 0, text.length).forEach { range ->
                drawCodeBoxes(result, range.start, range.end) { left, right, middle ->
                    drawRoundRect(background, Offset(left, middle - halfHeight), Size(right - left, halfHeight * 2), radius)
                }
            }
        }
    }
    BasicText(
        text,
        drawn,
        style = style,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        onTextLayout = { layout = it },
    )
}

/** Draws [text] with its backticked parts as code. A shorthand for [CodeText] over [splitInlineCode]. */
@Composable
fun CodeText(
    text: String,
    style: TextStyle,
    codeStyle: InlineCodeStyle,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
) {
    val runs = remember(text) { splitInlineCode(text) }
    CodeText(runs, style, codeStyle, modifier, maxLines)
}

private const val CODE_TAG = "code"

/** Builds the annotated text: each code run in Recursive, padded and tagged so its box can be found. */
private fun buildCodeString(runs: List<TextRun>, codeStyle: InlineCodeStyle, paddingSize: TextUnit): AnnotatedString =
    buildAnnotatedString {
        runs.forEach { run ->
            if (!run.isCode) {
                append(run.text)
                return@forEach
            }
            val start = length
            val padded = codeStyle.background != null && codeStyle.padding > 0.dp
            withStyle(SpanStyle(fontFamily = MonoFontFamily, fontSize = codeStyle.size, color = codeStyle.color)) {
                if (padded) withStyle(SpanStyle(fontSize = paddingSize)) { append(' ') }
                append(run.text)
                if (padded) withStyle(SpanStyle(fontSize = paddingSize)) { append(' ') }
            }
            addStringAnnotation(CODE_TAG, "", start, length)
        }
    }

/**
 * Calls [draw] once per line that the characters from [start] to [end] cover, with the left and
 * right edge of the characters on that line and the line's vertical middle.
 */
private inline fun drawCodeBoxes(
    layout: TextLayoutResult,
    start: Int,
    end: Int,
    draw: (left: Float, right: Float, middle: Float) -> Unit,
) {
    var index = start
    while (index < end) {
        val line = layout.getLineForOffset(index)
        val lineEnd = minOf(end, layout.getLineEnd(line, visibleEnd = true))
        if (lineEnd <= index) break
        val first = layout.getBoundingBox(index)
        val last = layout.getBoundingBox(lineEnd - 1)
        draw(first.left, last.right, (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f)
        index = maxOf(lineEnd, index + 1)
    }
}
