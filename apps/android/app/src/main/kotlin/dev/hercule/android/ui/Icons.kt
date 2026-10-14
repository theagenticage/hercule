package dev.hercule.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The book's interface icons, from the `ICONS` table in docs/design/crew-bureau-2/crew.js: line
 * drawings on a 16-unit grid, stroked 1.5 units wide with round caps and joins. Each SVG
 * `circle` and `rect` of the table is written here as the path it draws, and a dot drawn with
 * `fill="currentColor"` is filled.
 */
object BureauIcons {
    /** crew.js `plus`. */
    val Plus = buildIcon(strokes = listOf("M8 3.2v9.6M3.2 8h9.6"))

    /** crew.js `check`. */
    val Check = buildIcon(strokes = listOf("M3.4 8.4l3 3 6.2-6.6"))

    /** crew.js `close`. */
    val Close = buildIcon(strokes = listOf("M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"))

    /** crew.js `key`. */
    val Key = buildIcon(strokes = listOf("M2.6 10.6a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0 -5.6 0z", "M7.4 8.6l5.4-5.4M11 4.8l1.6 1.6M9.6 6.2l1.2 1.2"))

    /** crew.js `chev-l`. */
    val ChevronLeft = buildIcon(strokes = listOf("M9.8 3.8L5.6 8l4.2 4.2"))

    /** crew.js `chev-r`. */
    val ChevronRight = buildIcon(strokes = listOf("M6.2 3.8L10.4 8l-4.2 4.2"))

    /** crew.js `chev-d`. */
    val ChevronDown = buildIcon(strokes = listOf("M3.8 6.2L8 10.4l4.2-4.2"))

    /** crew.js `mic`. */
    val Mic = buildIcon(strokes = listOf("M8 2h0a2.2 2.2 0 0 1 2.2 2.2v3.2a2.2 2.2 0 0 1 -2.2 2.2h-0a2.2 2.2 0 0 1 -2.2 -2.2v-3.2a2.2 2.2 0 0 1 2.2 -2.2z", "M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2"))

    /** crew.js `memory`. */
    val Memory = buildIcon(strokes = listOf("M3.4 2.8h7.4a1.8 1.8 0 0 1 1.8 1.8v8.6H5.2a1.8 1.8 0 0 1-1.8-1.8z", "M3.4 11.4a1.8 1.8 0 0 1 1.8-1.8h7.4M6 5.4h4"))

    /** crew.js `diff`. */
    val Diff = buildIcon(strokes = listOf("M5 2.6v6M2 5.6h6M8.6 11.8H14"))

    /** crew.js `alarm`. */
    val Alarm = buildIcon(strokes = listOf("M3.2 8.8a4.8 4.8 0 1 0 9.6 0a4.8 4.8 0 1 0 -9.6 0z", "M8 6.6v2.4l1.6 1M2.6 3.6l1.8-1.4M13.4 3.6l-1.8-1.4"))

    /** crew.js `heart`. */
    val Heart = buildIcon(strokes = listOf("M2.2 8.2h2.6l1.4-3 2.2 6 1.6-3.4h3.8"))

    /** crew.js `intake`. */
    val Intake = buildIcon(strokes = listOf("M2.4 9.2h3.2l1 1.8h2.8l1-1.8h3.2", "M2.4 9.2l1.6-5.4h8l1.6 5.4v3.6a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z"))

    /** crew.js `threads`. */
    val Threads = buildIcon(strokes = listOf("M2.6 4.4a1.6 1.6 0 0 1 1.6-1.6h7.6a1.6 1.6 0 0 1 1.6 1.6v5a1.6 1.6 0 0 1-1.6 1.6H7.4L4.4 13.4V11h-.2a1.6 1.6 0 0 1-1.6-1.6z"))

    /** crew.js `connections`. */
    val Connections = buildIcon(strokes = listOf("M6 2.6v2.6M10 2.6v2.6M4.2 5.2h7.6v2.4a3.8 3.8 0 0 1-7.6 0zM8 11.4v2.2"))

    /** crew.js `bell`. */
    val Bell = buildIcon(strokes = listOf("M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1 1.2H3z", "M6.6 13.6a1.5 1.5 0 0 0 2.8 0"))

    /** crew.js `bolt`. */
    val Bolt = buildIcon(strokes = listOf("M8.8 2L4 9h3.6L7 14l5-7H8.4z"))

    /** crew.js `office`. */
    val Office = buildIcon(strokes = listOf("M2.4 13.6h11.2M3.6 13.6V6.4L8 3l4.4 3.4v7.2", "M6.4 13.6v-3.4h3.2v3.4"))

    /** crew.js `user`. */
    val User = buildIcon(strokes = listOf("M5.2 5.6a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0 -5.6 0z", "M2.8 13.6c.6-2.8 2.6-4.4 5.2-4.4s4.6 1.6 5.2 4.4"))

    /** crew.js `send`. */
    val Send = buildIcon(strokes = listOf("M8 13V3.4M4 7.2L8 3.2l4 4"))

    /** crew.js `stop`. */
    val Stop = buildIcon(strokes = listOf(), fills = listOf("M6 4.4h4a1.6 1.6 0 0 1 1.6 1.6v4a1.6 1.6 0 0 1 -1.6 1.6h-4a1.6 1.6 0 0 1 -1.6 -1.6v-4a1.6 1.6 0 0 1 1.6 -1.6z"))

    /** crew.js `m-waiting`. */
    val WaitingMark = buildIcon(strokes = listOf("M2.4 8a5.6 5.6 0 1 0 11.2 0a5.6 5.6 0 1 0 -11.2 0z"), fills = listOf("M5.6 8a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0z"))

    /** crew.js `m-working`, without the book's animation, in which the dots take turns fading. */
    val WorkingMark = buildIcon(
        strokes = listOf(),
        fills = listOf(
            "M2.45 8a1.35 1.35 0 1 0 2.7 0a1.35 1.35 0 1 0 -2.7 0z",
            "M6.65 8a1.35 1.35 0 1 0 2.7 0a1.35 1.35 0 1 0 -2.7 0z",
            "M10.85 8a1.35 1.35 0 1 0 2.7 0a1.35 1.35 0 1 0 -2.7 0z",
        ),
    )

    /** crew.js `lock`. */
    val Lock = buildIcon(strokes = listOf("M5.2 7h5.6a1.8 1.8 0 0 1 1.8 1.8v3a1.8 1.8 0 0 1 -1.8 1.8h-5.6a1.8 1.8 0 0 1 -1.8 -1.8v-3a1.8 1.8 0 0 1 1.8 -1.8z", "M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"))

    /** crew.js `file`. */
    val File = buildIcon(strokes = listOf("M4 2.4h5l3 3v8.2H4z", "M9 2.4v3h3"))

    /** crew.js `terminal`. */
    val Terminal = buildIcon(strokes = listOf("M4 2.8h8a2 2 0 0 1 2 2v6.4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-6.4a2 2 0 0 1 2 -2z", "M4.8 6.2l2 1.8-2 1.8M8.4 10h2.8"))

    /** crew.js `question`. */
    val Question = buildIcon(strokes = listOf("M2.2 8a5.8 5.8 0 1 0 11.6 0a5.8 5.8 0 1 0 -11.6 0z", "M6.3 6.4a1.8 1.8 0 0 1 3.5.5c0 1.2-1.8 1.4-1.8 2.6"), fills = listOf("M7.6 11.4a0.4 0.4 0 1 0 0.8 0a0.4 0.4 0 1 0 -0.8 0z"))
}

/**
 * Builds an icon from SVG path strings on the book's 16-unit grid: [strokes] are drawn as
 * lines, [fills] as filled shapes. The colour is black; [BureauIcon] tints it.
 */
private fun buildIcon(strokes: List<String>, fills: List<String> = emptyList()): ImageVector {
    val builder = ImageVector.Builder(defaultWidth = 16.dp, defaultHeight = 16.dp, viewportWidth = 16f, viewportHeight = 16f)
    for (d in strokes) {
        builder.addPath(
            pathData = addPathNodes(d),
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 1.5f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
    }
    for (d in fills) builder.addPath(pathData = addPathNodes(d), fill = SolidColor(Color.Black))
    return builder.build()
}

/** Draws [icon] at [size] in [tint], as the book's `icon(name, size)` does. It is decorative. */
@Composable
fun BureauIcon(icon: ImageVector, tint: Color, modifier: Modifier = Modifier, size: Dp = 16.dp) {
    Image(
        imageVector = icon,
        contentDescription = null,
        modifier = modifier.size(size),
        contentScale = ContentScale.Fit,
        colorFilter = ColorFilter.tint(tint),
    )
}
