package dev.hercule.android.faces

import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.PathParser
import kotlin.math.cos
import kotlin.math.sin

// The few SVG elements a face is made of, drawn on a Compose canvas whose units are the face's
// drawing units. The face parts pass the desktop's own path strings and numbers, so each part
// reads like its SVG in apps/desktop/src/renderer/faces/.

// Every path string parsed so far. A face has a few dozen distinct strings, and Compose draws on
// the main thread only, so a plain map is enough.
private val parsedPaths = HashMap<String, Path>()

/** Returns the path an SVG path string [d] describes, parsing each distinct string once. */
private fun parseSvgPath(d: String): Path = parsedPaths.getOrPut(d) { PathParser().parsePathString(d).toPath() }

/** Returns a colour written in CSS as `oklch(l c h / alpha)`, with [hue] in degrees. */
internal fun oklch(lightness: Float, chroma: Float, hue: Float, alpha: Float = 1f): Color {
    val radians = Math.toRadians(hue.toDouble())
    return Color(lightness, chroma * cos(radians).toFloat(), chroma * sin(radians).toFloat(), alpha, ColorSpaces.Oklab)
}

/** How a line is drawn: SVG's `stroke`, `stroke-width`, `stroke-linecap` and `stroke-linejoin`. */
internal fun buildStroke(width: Float, roundCap: Boolean = true, roundJoin: Boolean = false, dashes: FloatArray? = null) = Stroke(
    width = width,
    cap = if (roundCap) StrokeCap.Round else StrokeCap.Butt,
    join = if (roundJoin) StrokeJoin.Round else StrokeJoin.Miter,
    pathEffect = dashes?.let { PathEffect.dashPathEffect(it) },
)

/** Fills the SVG path [d] with [color]. */
internal fun DrawScope.fillSvgPath(d: String, color: Color) = drawPath(parseSvgPath(d), color)

/** Strokes the SVG path [d] with [color]. */
internal fun DrawScope.strokeSvgPath(d: String, color: Color, stroke: Stroke) =
    drawPath(parseSvgPath(d), color, style = stroke)

/** Draws an SVG `ellipse`, filled when [stroke] is null, turned [rotation] degrees about its centre. */
internal fun DrawScope.drawSvgEllipse(
    cx: Float,
    cy: Float,
    rx: Float,
    ry: Float,
    color: Color,
    stroke: Stroke? = null,
    rotation: Float = 0f,
) = rotate(rotation, Offset(cx, cy)) {
    drawOval(color, Offset(cx - rx, cy - ry), Size(2 * rx, 2 * ry), style = stroke ?: Fill)
}

/** Draws an SVG `circle`, filled when [stroke] is null. */
internal fun DrawScope.drawSvgCircle(cx: Float, cy: Float, r: Float, color: Color, stroke: Stroke? = null) =
    drawCircle(color, r, Offset(cx, cy), style = stroke ?: Fill)

/** Draws an SVG `rect` with corner radius [rx], filled when [stroke] is null. */
internal fun DrawScope.drawSvgRect(x: Float, y: Float, width: Float, height: Float, rx: Float, color: Color, stroke: Stroke? = null) =
    drawRoundRect(color, Offset(x, y), Size(width, height), CornerRadius(rx), style = stroke ?: Fill)
