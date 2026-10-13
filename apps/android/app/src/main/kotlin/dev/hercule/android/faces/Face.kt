package dev.hercule.android.faces

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hercule.android.R
import dev.hercule.android.theme.BureauColors
import dev.hercule.android.theme.CrewColors
import dev.hercule.android.theme.CrewPalette

// A port of apps/desktop/src/renderer/faces/face.tsx and face.css.

/**
 * Draws a colleague's face: [look] in [pose], [size] square. The drawing is the Bureau book's
 * crew.js face, part for part, in the theme [colors]. [badgeRing] is the colour of the surface
 * behind the face, which the ring around a pose's badge takes; it is the theme's surface unless
 * the face sits on another one.
 *
 * The face is still. The desktop taps the working face's paws on one face only, the message its
 * agent is writing, and the book's blink, wave and z's are left out on both platforms.
 *
 * The face has no accessibility text: every place that draws one also writes who it is and its
 * [Pose.words], so a description on the face would only repeat them.
 */
@Composable
fun Face(
    look: Look,
    pose: Pose,
    size: Dp,
    colors: BureauColors,
    modifier: Modifier = Modifier,
    badgeRing: Color = colors.surface,
) {
    val paints = remember(colors, look.hue, badgeRing) {
        FacePaints(colors, selectCrewColors(colors.crew, look.hue), badgeRing)
    }
    val sleepLetters = if (pose == Pose.Asleep) rememberSleepLetters() else null
    // Small faces get thicker strokes and larger eyes, so they still read.
    val bold = isBold(size)
    Canvas(modifier.size(size)) {
        // The drawing's units: 45 of them across the face, starting at x 3, y 1.
        scale(this.size.width / 45f, pivot = Offset.Zero) {
            translate(-3f, -1f) {
                drawWithPoseFilter(pose) { drawFace(look, pose, bold, paints, sleepLetters) }
            }
        }
    }
}

/** Checks whether a face of [size] is drawn bold: below 30 dp, with thicker strokes and larger eyes. */
internal fun isBold(size: Dp): Boolean = size < 30.dp

/** Returns the colours of [hue] in [palette]. */
fun selectCrewColors(palette: CrewPalette, hue: Hue): CrewColors = when (hue) {
    Hue.Iris -> palette.iris
    Hue.Teal -> palette.teal
    Hue.Orchid -> palette.orchid
    Hue.Lime -> palette.lime
    Hue.Sky -> palette.sky
    Hue.Peach -> palette.peach
    Hue.Mint -> palette.mint
    Hue.Grape -> palette.grape
}

/** Draws every part of a face, in the desktop's order, each later part over the earlier ones. */
private fun DrawScope.drawFace(look: Look, pose: Pose, bold: Boolean, paints: FacePaints, sleepLetters: SleepLetters?) {
    val topY = readBodyMetrics(look.shape).topY
    val body = buildBodyPath(look.shape)
    val ink = paints.theme.faceInk
    // The body twice: its shade as the base it sits on, then the body itself, 2 units higher.
    fillSvgPath(body, paints.who.whoShade)
    translate(0f, -2f) { fillSvgPath(body, paints.who.who) }
    val highlightY = (topY + 6.4).toFloat()
    drawSvgEllipse(17.4f, highlightY, 3.6f, 2.1f, Color.White.copy(alpha = 0.34f), rotation = -30f)
    drawSvgEllipse(15f, 31.4f, 2.6f, 1.6f, paints.theme.blush)
    drawSvgEllipse(33f, 31.4f, 2.6f, 1.6f, paints.theme.blush)
    drawEyes(pose, bold, ink)
    drawBrows(pose, bold, ink)
    drawMouth(pose, bold, Accessory.Tache in look.accessories, ink)
    for (accessory in look.accessories) drawAccessory(accessory, topY, paints)
    look.headwear?.let { drawHeadwear(it, topY, paints) }
    drawPoseExtras(pose, paints, sleepLetters)
}

/**
 * Runs [draw], and fades the whole face for the asleep and away poses: asleep at half the
 * colour, away at 30% of the colour and 55% opacity, as face.css filters them. The filter
 * applies to the face as one picture, so the face is drawn into a layer first.
 */
private fun DrawScope.drawWithPoseFilter(pose: Pose, draw: DrawScope.() -> Unit) {
    val (saturation, alpha) = when (pose) {
        Pose.Asleep -> 0.5f to 1f
        Pose.Away -> 0.3f to 0.55f
        else -> return draw()
    }
    val paint = Paint().apply {
        this.alpha = alpha
        colorFilter = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(saturation) })
    }
    // The layer reaches past the 45-unit box, because the badge's ring does.
    drawContext.canvas.saveLayer(Rect(0f, 0f, 51f, 50f), paint)
    draw()
    drawContext.canvas.restore()
}

// Bricolage Grotesque at the asleep z's weight, 760. The theme's interface family stops at 640.
// The z's are 10 and 7 units tall, below the font's smallest optical size, so opsz is its minimum.
private val SleepLetterFont = FontFamily(
    Font(
        R.font.bricolage_grotesque,
        weight = FontWeight(760),
        variationSettings = FontVariation.Settings(FontVariation.weight(760), FontVariation.Setting("opsz", 12f)),
    ),
)

/** Returns the asleep pose's two z's, laid out in face units: one unit is one pixel at density 1. */
@Composable
private fun rememberSleepLetters(): SleepLetters {
    val measurer = rememberTextMeasurer()
    return remember(measurer) {
        val measureZ = { fontSize: Int ->
            measurer.measure(
                "z",
                TextStyle(fontFamily = SleepLetterFont, fontWeight = FontWeight(760), fontSize = fontSize.sp),
                density = Density(1f),
            )
        }
        SleepLetters(large = measureZ(10), small = measureZ(7))
    }
}
