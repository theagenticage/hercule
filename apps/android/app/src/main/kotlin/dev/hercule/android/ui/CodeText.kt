package dev.hercule.android.ui

import android.animation.ValueAnimator
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hercule.android.theme.MonoFontFamily
import kotlinx.coroutines.delay

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
    val paddingSize = rememberChipPaddingSize(codeStyle)
    val text = remember(runs, codeStyle, paddingSize) { buildCodeString(runs, codeStyle, paddingSize) }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val drawn = if (codeStyle.background == null) {
        modifier
    } else {
        modifier.drawBehind { layout?.let { drawCodeChips(it, text, codeStyle) } }
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

/** The inline content id of the streaming caret, which [buildCaret] draws. */
internal const val CARET_ID = "caret"

/**
 * Builds the streaming caret in [color], the book's `.caret`: a bar 8 wide and 16 tall with 2 dp
 * corners, 3 dp after the last character, centred on the text. The text holds a [CHIP_PADDING]
 * in its place, tagged with [DRAWN_TAG].
 */
internal fun buildCaret(color: Color) = InlineTextContent(Placeholder(11.sp, 16.sp, PlaceholderVerticalAlign.TextCenter)) {
    StreamingCaret(color)
}

/**
 * Draws the streaming caret's bar in [color], blinking as the book's does. The book animates
 * it with `caret 1s steps(2) infinite`, opacity 0 at 50%. CSS applies `steps(2)` to each half
 * of that cycle, so the opacity is 1, then 0.5, then 0, then 0.5, for 250 ms each.
 *
 * The bar starts solid, so a screenshot taken before the first step draws it solid. Only its
 * alpha changes, read in the draw layer, so a step neither recomposes nor lays out the text: it
 * costs one redraw of the bar, four times a second. With animations turned off in the phone's
 * settings, it stays solid, as the book's does under `prefers-reduced-motion`.
 */
@Composable
private fun StreamingCaret(color: Color) {
    val alpha = remember { mutableFloatStateOf(1f) }
    LaunchedEffect(Unit) {
        if (!ValueAnimator.areAnimatorsEnabled()) return@LaunchedEffect
        var step = 0
        while (true) {
            delay(CARET_STEP_MILLIS)
            step = (step + 1) % CARET_ALPHAS.size
            alpha.floatValue = CARET_ALPHAS[step]
        }
    }
    Box(
        Modifier
            .padding(start = 3.dp)
            .fillMaxSize()
            .graphicsLayer { this.alpha = alpha.floatValue }
            .background(color, RoundedCornerShape(2.dp)),
    )
}

/** The caret's opacity at each step of its 1 s blink. */
private val CARET_ALPHAS = floatArrayOf(1f, 0.5f, 0f, 0.5f)

private const val CARET_STEP_MILLIS = 250L

/** Builds the annotated text: each code run in Recursive, padded and tagged so its box can be found. */
private fun buildCodeString(runs: List<TextRun>, codeStyle: InlineCodeStyle, paddingSize: TextUnit): AnnotatedString =
    buildAnnotatedString {
        runs.forEach { run -> if (run.isCode) appendCode(run.text, codeStyle, paddingSize) else append(run.text) }
    }

/**
 * Returns the font size of the space that pads each side of a code chip, so the space is as wide
 * as [InlineCodeStyle.padding]. Recursive's monospaced advance is 0.6 em wide, so a space of
 * padding / 0.6 fills the padding.
 */
@Composable
internal fun rememberChipPaddingSize(codeStyle: InlineCodeStyle): TextUnit {
    val density = LocalDensity.current
    return remember(density, codeStyle.padding) { with(density) { (codeStyle.padding.toPx() / 0.6f).toSp() } }
}

/**
 * Appends [code] in Recursive, as [codeStyle] draws it, tagged so [drawCodeChips] finds its box.
 * When the chip has a background and a padding, a [CHIP_PADDING] of [paddingSize] (from
 * [rememberChipPaddingSize]) pads each side, so the padding takes room in the line as a CSS
 * padding does. Each padding character is tagged with [DRAWN_TAG], so a copy of the text can
 * leave it out.
 */
internal fun AnnotatedString.Builder.appendCode(code: String, codeStyle: InlineCodeStyle, paddingSize: TextUnit) {
    val start = length
    val padded = codeStyle.background != null && codeStyle.padding > 0.dp
    withStyle(SpanStyle(fontFamily = MonoFontFamily, fontSize = codeStyle.size, color = codeStyle.color)) {
        if (padded) appendDrawn { withStyle(SpanStyle(fontSize = paddingSize)) { append(CHIP_PADDING) } }
        append(code)
        if (padded) appendDrawn { withStyle(SpanStyle(fontSize = paddingSize)) { append(CHIP_PADDING) } }
    }
    addStringAnnotation(CODE_TAG, "", start, length)
}

/** The no-break space that pads a code chip on each side. */
internal const val CHIP_PADDING = '\u00A0'

/**
 * The tag of a character that stands in the text for something drawn rather than written: the
 * padding on each side of a code chip, and the streaming caret. A copy of the text leaves every
 * character so tagged out, by its offset, so no character the text really holds is ever lost.
 */
internal const val DRAWN_TAG = "drawn"

/** Appends what [append] appends, tagged with [DRAWN_TAG]. */
internal inline fun AnnotatedString.Builder.appendDrawn(append: AnnotatedString.Builder.() -> Unit) {
    val start = length
    append()
    addStringAnnotation(DRAWN_TAG, "", start, length)
}

/**
 * Draws the rounded background of every code chip that [appendCode] put in [text], from the
 * laid-out [layout] of that text, one box per line a chip covers. Compose has no rounded
 * background for a span, so the box is drawn behind the text.
 */
internal fun DrawScope.drawCodeChips(layout: TextLayoutResult, text: AnnotatedString, codeStyle: InlineCodeStyle) {
    val background = codeStyle.background ?: return
    val radius = CornerRadius(codeStyle.radius.toPx())
    // The box is the code's em box with 1 dp above and below, as the book's `padding: 1px 5px`.
    val halfHeight = codeStyle.size.toPx() * 0.62f + 1.dp.toPx()
    text.getStringAnnotations(CODE_TAG, 0, text.length).forEach { range ->
        forEachLineOfRange(layout, range.start, range.end) { left, right, line ->
            val middle = (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f
            drawRoundRect(background, Offset(left, middle - halfHeight), Size(right - left, halfHeight * 2), radius)
        }
    }
}

/**
 * Calls [action] once per line that the characters from [start] to [end] of [layout] cover,
 * with the left and right edge of the characters on that line and the line's index.
 */
internal inline fun forEachLineOfRange(
    layout: TextLayoutResult,
    start: Int,
    end: Int,
    action: (left: Float, right: Float, line: Int) -> Unit,
) {
    var index = start
    while (index < end) {
        val line = layout.getLineForOffset(index)
        val lineEnd = minOf(end, layout.getLineEnd(line, visibleEnd = true))
        if (lineEnd <= index) break
        val first = layout.getBoundingBox(index)
        val last = layout.getBoundingBox(lineEnd - 1)
        // In right-to-left text the first character is the rightmost one.
        action(minOf(first.left, last.left), maxOf(first.right, last.right), line)
        index = maxOf(lineEnd, index + 1)
    }
}
