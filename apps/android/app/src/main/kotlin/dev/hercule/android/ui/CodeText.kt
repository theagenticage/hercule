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
internal fun StreamingCaret(color: Color, modifier: Modifier = Modifier) {
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
        modifier
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
 * When [paddingSize] is given and the chip has a background and a padding, a [CHIP_PADDING] of
 * that size (from [rememberChipPaddingSize]) pads each side, so the padding takes room in the
 * line as a CSS padding does. Without it, the code is appended alone and the caller makes room
 * for the padding, as a message's markdown does, whose selected text must hold no character
 * nobody wrote.
 */
internal fun AnnotatedString.Builder.appendCode(code: String, codeStyle: InlineCodeStyle, paddingSize: TextUnit?) {
    val start = length
    val padded = paddingSize != null && codeStyle.background != null && codeStyle.padding > 0.dp
    withStyle(SpanStyle(fontFamily = MonoFontFamily, fontSize = codeStyle.size, color = codeStyle.color)) {
        if (padded) withStyle(SpanStyle(fontSize = paddingSize)) { append(CHIP_PADDING) }
        append(code)
        if (padded) withStyle(SpanStyle(fontSize = paddingSize)) { append(CHIP_PADDING) }
    }
    addStringAnnotation(CODE_TAG, "", start, length)
}

/** The no-break space that pads a code chip on each side. */
internal const val CHIP_PADDING = '\u00A0'

/**
 * Draws the rounded background of every code chip that [appendCode] put in [text], from the
 * laid-out [layout] of that text, one box per line a chip covers. Compose has no rounded
 * background for a span, so the box is drawn behind the text.
 *
 * [outset] widens the box past the code, for a chip whose padding holds no character: on the
 * sides the [roomTag] annotation over the chip names ("s" for its start, "e" for its end), or on
 * none. The start and the end are the logical ones, on the side of the piece their character
 * lies at ([buildRangeSegments]). A chip broken over lines or by mixed directions is widened
 * only at its start and at its end, as CSS slices a broken inline box. The box never reaches past the text's
 * edges, so a chip that starts or ends a wrapped line lies flush with the column there.
 */
internal fun DrawScope.drawCodeChips(layout: TextLayoutResult, text: AnnotatedString, codeStyle: InlineCodeStyle, outset: Float = 0f, roomTag: String? = null) {
    val background = codeStyle.background ?: return
    val radius = CornerRadius(codeStyle.radius.toPx())
    // The box is the code's em box with 1 dp above and below, as the book's `padding: 1px 5px`.
    val halfHeight = codeStyle.size.toPx() * 0.62f + 1.dp.toPx()
    text.getStringAnnotations(CODE_TAG, 0, text.length).forEach { range ->
        if (range.end <= range.start) return@forEach
        val room = roomTag?.let { tag -> text.getStringAnnotations(tag, range.start, range.end).firstOrNull()?.item }.orEmpty()
        val startOutset = if ('s' in room) outset else 0f
        val endOutset = if ('e' in room) outset else 0f
        buildRangeSegments(layout, range.start, range.end).forEach { segment ->
            val middle = (layout.getLineTop(segment.line) + layout.getLineBottom(segment.line)) / 2f
            var boxLeft = segment.left
            var boxRight = segment.right
            when (segment.startEdge) {
                Edge.Left -> boxLeft -= startOutset
                Edge.Right -> boxRight += startOutset
                null -> Unit
            }
            when (segment.endEdge) {
                Edge.Left -> boxLeft -= endOutset
                Edge.Right -> boxRight += endOutset
                null -> Unit
            }
            boxLeft = boxLeft.coerceAtLeast(0f)
            boxRight = boxRight.coerceAtMost(layout.size.width.toFloat())
            drawRoundRect(background, Offset(boxLeft, middle - halfHeight), Size(boxRight - boxLeft, halfHeight * 2), radius)
        }
    }
}

/**
 * One piece of a range of text as it is drawn: from [left] to [right] on [line], where the
 * range's characters touch on screen. [startEdge] and [endEdge] say whether the range's first
 * or last character lies in the piece, and on which side of it, or null when it does not.
 */
internal class RangeSegment(val left: Float, val right: Float, val line: Int, val startEdge: Edge?, val endEdge: Edge?)

/** A side of a [RangeSegment]. */
internal enum class Edge { Left, Right }

/**
 * Returns the pieces the characters from [start] to [end] of [layout] are drawn in, line by
 * line, left to right. In text of one direction a line holds one piece. In mixed-direction text
 * the characters of the range can lie apart on screen, and the first and last character are
 * not its two ends, so the pieces are made from every character's box: boxes that touch make
 * one piece, and text outside the range between two pieces is never covered.
 */
internal fun buildRangeSegments(layout: TextLayoutResult, start: Int, end: Int): List<RangeSegment> {
    val text = layout.layoutInput.text.text
    val segments = mutableListOf<RangeSegment>()
    var index = start
    while (index < end) {
        val line = layout.getLineForOffset(index)
        // Spaces hanging past a line's visible end are drawn nowhere; the range goes on on the next line.
        val visibleEnd = minOf(end, layout.getLineEnd(line, visibleEnd = true))
        val boxes = (index until visibleEnd).filterNot { Character.isLowSurrogate(text[it]) }.map { it to layout.getBoundingBox(it) }.sortedBy { it.second.left }
        var pieceLeft = Float.NaN
        var pieceRight = Float.NaN
        var startBox: Pair<Float, Float>? = null
        var endBox: Pair<Float, Float>? = null
        fun close() {
            if (pieceLeft.isNaN()) return
            fun edgeOf(box: Pair<Float, Float>?) = box?.let { (left, right) -> if (left - pieceLeft <= pieceRight - right) Edge.Left else Edge.Right }
            segments += RangeSegment(pieceLeft, pieceRight, line, edgeOf(startBox), edgeOf(endBox))
            pieceLeft = Float.NaN
            startBox = null
            endBox = null
        }
        boxes.forEach { (offset, box) ->
            // Half a pixel of slack joins boxes that touch but round apart.
            if (!pieceLeft.isNaN() && box.left > pieceRight + 0.5f) close()
            if (pieceLeft.isNaN()) {
                pieceLeft = box.left
                pieceRight = box.right
            } else {
                pieceRight = maxOf(pieceRight, box.right)
            }
            if (offset == start) startBox = box.left to box.right
            if (offset == end - 1 || (offset == end - 2 && Character.isHighSurrogate(text[offset]))) endBox = box.left to box.right
        }
        close()
        index = maxOf(layout.getLineEnd(line), index + 1)
    }
    return segments
}
