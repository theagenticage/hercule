package dev.hercule.android.faces

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.drawText
import dev.hercule.android.theme.BureauColors
import dev.hercule.android.theme.CrewColors

// A port of apps/desktop/src/renderer/faces/face-parts.tsx: the parts of a face that change with
// its pose. Every number is the desktop's, which is the Bureau book's crew.js. `bold` is true
// below 30 dp, where strokes are thicker and eyes larger so the face still reads.

/** The colours one face is painted in: the theme's, the face's own hue, and the ring around its badge. */
internal class FacePaints(val theme: BureauColors, val who: CrewColors, val badgeRing: Color)

/** The y of the eyes' centres. */
private const val EYE_Y = 26.6

/** Returns how much larger the eyes are drawn: 1.2 times on a bold face, so small faces still read. */
internal fun computeEyeScale(bold: Boolean): Double = if (bold) 1.2 else 1.0

/** Returns the y of the mouth: lower under a tache, so it shows beneath it. */
internal fun computeMouthY(wearsTache: Boolean): Double = if (wearsTache) 34.4 else 32.6

/**
 * Checks whether a face in [pose] shows its mouth. A tache hides the working, paused, asleep,
 * away and idle mouths; the waiting, done and failed mouths still show below it.
 */
internal fun showsMouth(pose: Pose, wearsTache: Boolean): Boolean =
    !wearsTache || pose == Pose.Waiting || pose == Pose.Done || pose == Pose.Failed

/** Draws the white highlight in an eye centred on [x], [y], for an eye scaled by [scale]. */
private fun DrawScope.drawGlint(x: Double, y: Double, scale: Double) =
    drawSvgCircle((x + 0.7).toFloat(), (y - 0.9).toFloat(), (0.7 * scale).toFloat(), Color.White.copy(alpha = 0.9f))

/** Draws one eye in [pose], centred on [x]. */
private fun DrawScope.drawEye(pose: Pose, x: Double, bold: Boolean, ink: Color) {
    val scale = computeEyeScale(bold)
    val stroke = buildStroke(if (bold) 1.9f else 1.5f)
    when (pose) {
        // Lowered to the typewriter.
        Pose.Working -> {
            drawSvgEllipse(x.toFloat(), (EYE_Y + 1).toFloat(), (2 * scale).toFloat(), (2.2 * scale).toFloat(), ink)
            drawGlint(x, EYE_Y + 1, scale)
        }
        Pose.Paused -> strokeSvgPath(
            "M${formatSvgNumber(x - 2.2 * scale)} ${formatSvgNumber(EYE_Y + 0.2)}h${formatSvgNumber(4.4 * scale)}",
            ink,
            stroke,
        )
        Pose.Asleep -> strokeSvgPath("M${formatSvgNumber(x - 2.3)} ${formatSvgNumber(EYE_Y)}q2.3 2 4.6 0", ink, stroke)
        Pose.Done -> strokeSvgPath("M${formatSvgNumber(x - 2.3)} ${formatSvgNumber(EYE_Y + 1)}q2.3-2.8 4.6 0", ink, stroke)
        Pose.Away -> drawSvgCircle((x - 1).toFloat(), (EYE_Y + 0.3).toFloat(), (1.5 * scale).toFloat(), ink)
        // Waiting eyes are open wider and sit a little higher.
        Pose.Waiting, Pose.Idle, Pose.Failed -> {
            val y = if (pose == Pose.Waiting) EYE_Y - 0.5 else EYE_Y
            val ry = if (pose == Pose.Waiting) 2.75 else 2.55
            drawSvgEllipse(x.toFloat(), y.toFloat(), (2 * scale).toFloat(), (ry * scale).toFloat(), ink)
            drawGlint(x, y, scale)
        }
    }
}

/** Draws both eyes of a face in [pose], the left one first. */
internal fun DrawScope.drawEyes(pose: Pose, bold: Boolean, ink: Color) {
    drawEye(pose, 19.0, bold, ink)
    drawEye(pose, 29.0, bold, ink)
}

/** Draws the brows of a face in [pose]. Only the waiting, working and failed poses have brows. */
internal fun DrawScope.drawBrows(pose: Pose, bold: Boolean, ink: Color) {
    val d = when (pose) {
        Pose.Waiting -> "M16.9 21.6q2.1-1.4 4.2 0M26.9 21.6q2.1-1.4 4.2 0"
        Pose.Working -> "M17.2 22.3l3.6.5M30.8 22.3l-3.6.5"
        Pose.Failed -> "M16.8 22.8l4.2-1.5M31.2 22.8l-4.2-1.5"
        else -> return
    }
    strokeSvgPath(d, ink, buildStroke(if (bold) 1.6f else 1.25f))
}

/** Draws the mouth of a face in [pose], unless a tache hides it (see [showsMouth]). */
internal fun DrawScope.drawMouth(pose: Pose, bold: Boolean, wearsTache: Boolean, ink: Color) {
    if (!showsMouth(pose, wearsTache)) return
    val stroke = buildStroke(if (bold) 1.8f else 1.45f)
    val y = computeMouthY(wearsTache)
    when (pose) {
        Pose.Waiting -> drawSvgEllipse(24f, (y + 0.2).toFloat(), 1.5f, 1.7f, ink)
        Pose.Done -> strokeSvgPath("M21 ${formatSvgNumber(y - 1.2)}q3 3.2 6 0", ink, stroke)
        Pose.Failed -> strokeSvgPath("M21.4 ${formatSvgNumber(y + 0.6)}q1.3-1.3 2.6 0t2.6 0", ink, stroke)
        Pose.Working, Pose.Paused -> strokeSvgPath("M22.6 ${formatSvgNumber(y)}h2.8", ink, stroke)
        Pose.Asleep -> strokeSvgPath("M23 ${formatSvgNumber(y)}q1 .8 2 0", ink, stroke)
        Pose.Away -> strokeSvgPath(
            "M22.2 ${formatSvgNumber(y)}h3.6",
            ink,
            buildStroke(if (bold) 1.8f else 1.45f, dashes = floatArrayOf(0.1f, 1.8f)),
        )
        Pose.Idle -> strokeSvgPath("M21.6 ${formatSvgNumber(y - 1.2)}q2.4 2.3 4.8 0", ink, stroke)
    }
}

/**
 * Draws the round badge in the face's lower right corner: a disc in [fill] with a ring in the
 * colour of the surface behind the face. An outlined badge adds a thin inner ring, for the
 * badges drawn in the raised colour.
 */
private fun DrawScope.drawBadge(fill: Color, outlined: Boolean, paints: FacePaints) {
    drawSvgCircle(40f, 39f, 5.6f, fill)
    drawSvgCircle(40f, 39f, 5.6f, paints.badgeRing, buildStroke(2f))
    if (outlined) drawSvgCircle(40f, 39f, 4.4f, paints.theme.line.copy(alpha = 0.8f), buildStroke(0.8f))
}

/** Draws the working pose's typewriter: its body, then its keys as dots. */
private fun DrawScope.drawTypewriter(paints: FacePaints) {
    fillSvgPath("M11.4 45.4l2.4-5h20.4l2.4 5z", paints.theme.hat)
    val keys = paints.theme.surface.copy(alpha = 0.55f)
    for (x in floatArrayOf(17f, 20.4f, 24f, 27.6f, 31f)) drawSvgCircle(x, 43.4f, 0.7f, keys)
}

/** Draws one of the working pose's paws, at x 18 or 30: the body's shade with a faint outline. */
private fun DrawScope.drawPaw(x: Float, paints: FacePaints) {
    drawSvgEllipse(x, 40.4f, 2.8f, 1.9f, paints.who.whoShade)
    drawSvgEllipse(x, 40.4f, 2.8f, 1.9f, paints.theme.faceInk.copy(alpha = 0.25f), buildStroke(0.6f, roundCap = false))
}

/**
 * Draws what [pose] adds around the face:
 * - working: a typewriter with two paws on it;
 * - waiting: a raised arm with a palm in the "you" colour, because the face asks for you;
 * - asleep: two z's, from [sleepLetters] (a large and a small "z");
 * - failed: a plaster on the cheek and a red badge with an X;
 * - done: a green badge with a check;
 * - paused and away: an outlined badge.
 *
 * Everything is drawn still: the app does not animate faces (see [Face]).
 */
internal fun DrawScope.drawPoseExtras(pose: Pose, paints: FacePaints, sleepLetters: SleepLetters?) {
    val theme = paints.theme
    when (pose) {
        Pose.Working -> {
            drawTypewriter(paints)
            drawPaw(18f, paints)
            drawPaw(30f, paints)
        }
        Pose.Waiting -> {
            strokeSvgPath("M36.8 33C40.4 30.4 41.6 24.4 41.8 18.4", paints.who.whoShade, buildStroke(3.4f))
            drawSvgRect(37.8f, 6.8f, 8f, 10.6f, 4f, theme.you)
            drawSvgRect(37.8f, 6.8f, 8f, 10.6f, 4f, paints.who.whoShade, buildStroke(1.3f, roundCap = false))
            drawSvgEllipse(37.6f, 13.4f, 1.7f, 2.5f, theme.you, rotation = -32f)
            drawSvgEllipse(37.6f, 13.4f, 1.7f, 2.5f, paints.who.whoShade, buildStroke(1.1f, roundCap = false), rotation = -32f)
        }
        Pose.Asleep -> if (sleepLetters != null) {
            drawLetter(sleepLetters.large, 37.4f, 15f, theme.muted)
            drawLetter(sleepLetters.small, 42.6f, 8.4f, theme.muted)
        }
        Pose.Failed -> {
            rotate(-30f, Offset(14.6f, 32.4f)) {
                drawSvgRect(9.6f, 30.1f, 10f, 4.6f, 2.3f, PlasterColor)
                drawSvgRect(9.6f, 30.1f, 10f, 4.6f, 2.3f, PlasterEdgeColor, buildStroke(0.7f, roundCap = false))
                drawSvgRect(13.1f, 30.7f, 3f, 3.4f, 0.7f, PlasterPadColor)
            }
            drawBadge(theme.fail, outlined = false, paints)
            strokeSvgPath("M38.3 37.3l3.4 3.4M41.7 37.3l-3.4 3.4", Color.White, buildStroke(1.6f))
        }
        Pose.Done -> {
            drawBadge(theme.ok, outlined = false, paints)
            strokeSvgPath("M37.6 39.2l1.6 1.6 3.2-3.4", Color.White, buildStroke(1.6f, roundJoin = true))
        }
        Pose.Paused -> {
            drawBadge(theme.raised, outlined = true, paints)
            strokeSvgPath("M38.8 37.2v3.6M41.2 37.2v3.6", theme.ink, buildStroke(1.5f))
        }
        Pose.Away -> {
            drawBadge(theme.raised, outlined = true, paints)
            strokeSvgPath("M37.6 40.8l4.8-4.8M37.8 37.2a3 3 0 0 1 4.6 0", theme.muted, buildStroke(1.3f))
        }
        Pose.Idle -> Unit
    }
}

/** The asleep pose's two z's, laid out once in face units: a large one and a small one. */
internal class SleepLetters(val large: TextLayoutResult, val small: TextLayoutResult)

/** Draws [letter] with its baseline's left end at [x], [y], as SVG places `text`. */
private fun DrawScope.drawLetter(letter: TextLayoutResult, x: Float, y: Float, color: Color) =
    drawText(letter, color, Offset(x, y - letter.firstBaseline))

// The plaster's paper, edge and pad, literal colours in the desktop's face-parts.tsx.
private val PlasterColor = oklch(0.95f, 0.03f, 75f)
private val PlasterEdgeColor = oklch(0.7f, 0.05f, 60f)
private val PlasterPadColor = oklch(0.85f, 0.05f, 65f)
