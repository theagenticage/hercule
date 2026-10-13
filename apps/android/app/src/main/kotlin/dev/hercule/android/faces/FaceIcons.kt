package dev.hercule.android.faces

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.ImageBitmapConfig
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.core.graphics.drawable.IconCompat
import dev.hercule.android.alerts.AlertFacePose
import dev.hercule.android.alerts.AlertFaces
import dev.hercule.android.theme.BureauColors
import dev.hercule.android.theme.OrientExpressColors
import dev.hercule.android.theme.WhitehavenColors

/**
 * Draws the crew faces alerts show into bitmaps, the same drawing [Face] makes on screen.
 *
 * The colours follow the theme the phone shows now, Whitehaven by day and Orient Express at
 * night, as the alerts' accent colour does. An icon drawn by day keeps its day colours until
 * the alert is posted again.
 */
class FaceIcons(private val context: Context) : AlertFaces {
    override fun drawPersonIcon(seedId: String, isAssistant: Boolean, pose: AlertFacePose): IconCompat {
        val look = if (isAssistant) buildAssistantLook(seedId) else buildLook(seedId)
        val colors = readThemeColors()
        val who = selectCrewColors(colors.crew, look.hue)
        val bitmap = drawBitmap(PERSON_ICON_SIDE) {
            // An adaptive icon is masked to a circle, so the background fills the whole square.
            drawRect(who.whoTint)
            val faceSide = PERSON_ICON_SIDE * PERSON_FACE_SHARE
            val inset = (PERSON_ICON_SIDE - faceSide) / 2
            translate(inset, inset) {
                drawScaledFace(look, mapPose(pose), faceSide, bold = true, FacePaints(colors, who, who.whoTint), sleepLetters = null)
            }
        }
        return IconCompat.createWithAdaptiveBitmap(bitmap)
    }

    override fun drawTrackerIcon(sessionId: String, pose: AlertFacePose): IconCompat {
        val look = buildLook(sessionId)
        val colors = readThemeColors()
        val bitmap = drawBitmap(TRACKER_ICON_SIDE) {
            // None of the alert poses has a badge, so the face fills the whole square.
            val paints = FacePaints(colors, selectCrewColors(colors.crew, look.hue), colors.surface)
            drawScaledFace(look, mapPose(pose), TRACKER_ICON_SIDE.toFloat(), bold = true, paints, sleepLetters = null)
        }
        return IconCompat.createWithBitmap(bitmap)
    }

    override fun readHueColor(sessionId: String): Int =
        selectCrewColors(readThemeColors().crew, buildLook(sessionId).hue).who.toArgb()

    private fun readThemeColors(): BureauColors =
        if (context.resources.configuration.isNightModeActive) OrientExpressColors else WhitehavenColors

    private companion object {
        /** An adaptive icon's 108 dp, at 2 px a dp; Android scales it to the size it shows. */
        const val PERSON_ICON_SIDE = 216

        /**
         * The face's share of an adaptive icon: small enough that the waiting pose's raised
         * card stays inside the 66 dp circle Android never masks.
         */
        const val PERSON_FACE_SHARE = 0.5f

        const val TRACKER_ICON_SIDE = 96
    }
}

/** Returns the crew pose an alert's [pose] draws. */
internal fun mapPose(pose: AlertFacePose): Pose = when (pose) {
    AlertFacePose.Working -> Pose.Working
    AlertFacePose.Waiting -> Pose.Waiting
    AlertFacePose.Idle -> Pose.Idle
}

/** Returns a [side] pixels square bitmap in Display P3, the theme's colour space, with [draw] drawn on it. */
private fun drawBitmap(side: Int, draw: DrawScope.() -> Unit): Bitmap {
    val image = ImageBitmap(side, side, ImageBitmapConfig.Argb8888, hasAlpha = true, colorSpace = ColorSpaces.DisplayP3)
    val size = Size(side.toFloat(), side.toFloat())
    CanvasDrawScope().draw(Density(1f), LayoutDirection.Ltr, Canvas(image), size, draw)
    return image.asAndroidBitmap()
}
