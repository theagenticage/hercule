package dev.hercule.android.faces

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope

// A port of apps/desktop/src/renderer/faces/accessories.tsx: what a colleague wears, drawn on top
// of the body as the Bureau book's crew.js draws it. `topY` is the y of the top of the body: the
// hats sit relative to it, so one hat fits every shape. The homburg, the bowtie and all headwear
// are drawn in the theme's hat colour, a near-black that works on every hue and theme.

/** Returns the y [dy] below the top of the body at [topY], rounded and formatted as crew.js writes it. */
private fun formatHatY(topY: Double, dy: Double): String = formatSvgNumber(roundToHundredths(topY + dy))

/** Draws one [accessory] on a body whose top is at [topY]. */
internal fun DrawScope.drawAccessory(accessory: Accessory, topY: Double, paints: FacePaints) {
    val theme = paints.theme
    when (accessory) {
        Accessory.Homburg -> {
            val y = { dy: Double -> formatHatY(topY, dy) }
            // A dented crown, a band in the wearer's own shade and a brim curled up at both ends.
            val crown = "M17 ${y(4.6)}" +
                "L17.5 ${y(-1.4)}" +
                "C17.7 ${y(-3.4)} 19.6 ${y(-3.9)} 21.2 ${y(-3.4)}" +
                "C22.5 ${y(-3.0)} 23 ${y(-2.3)} 24 ${y(-2.3)}" +
                "S25.5 ${y(-3.0)} 26.8 ${y(-3.4)}" +
                "C28.4 ${y(-3.9)} 30.3 ${y(-3.4)} 30.5 ${y(-1.4)}" +
                "L31 ${y(4.6)}z"
            val band = "M17.2 ${y(1.8)}h13.6l.2 2.4H17z"
            val brim = "M10.2 ${y(3.2)}" +
                "C11.2 ${y(5.9)} 15.6 ${y(6.8)} 24 ${y(6.8)}" +
                "S36.8 ${y(5.9)} 37.8 ${y(3.2)}" +
                "C36.2 ${y(4.7)} 31.2 ${y(5.0)} 24 ${y(5.0)}" +
                "S11.8 ${y(4.7)} 10.2 ${y(3.2)}z"
            fillSvgPath(crown, theme.hat)
            fillSvgPath(band, paints.who.whoShade)
            fillSvgPath(brim, theme.hat)
        }
        // Poirot's moustache: two full wings that thin out and curl up into waxed points.
        Accessory.Tache -> {
            fillSvgPath(
                "M24 30.9c-1.5-1.3-4.2-1.5-5.8-.1-.9.8-2 .8-2.6-.3 0 1.9 1.6 3 3.5 2.6 1.9-.4 3.4-1 4.9-1.3 " +
                    "1.5.3 3 .9 4.9 1.3 1.9.4 3.5-.7 3.5-2.6-.6 1.1-1.7 1.1-2.6.3-1.6-1.4-4.3-1.2-5.8.1z",
                theme.faceInk,
            )
            strokeSvgPath("M15.8 30.9c-.9-.3-1.3-1.2-.9-2M32.2 30.9c.9-.3 1.3-1.2.9-2", theme.faceInk, buildStroke(0.8f))
        }
        // The desktop draws the glasses as one group at opacity .85. Each piece takes that
        // opacity here instead; the bridge overlaps the rims by a fraction of a unit only.
        Accessory.Glasses -> {
            val rim = theme.faceInk.copy(alpha = 0.85f)
            val stroke = buildStroke(1.15f, roundCap = false)
            drawSvgCircle(19f, 26.6f, 4f, rim, stroke)
            drawSvgCircle(29f, 26.6f, 4f, rim, stroke)
            strokeSvgPath("M23 26.2h2", rim, stroke)
        }
        Accessory.Monocle -> {
            drawSvgCircle(29f, 26.6f, 4.2f, MonocleGlassColor)
            drawSvgCircle(29f, 26.6f, 4.2f, theme.faceInk, buildStroke(1.2f, roundCap = false))
            strokeSvgPath("M32.4 29.2c1.4 2.6 1.6 5.6.6 8.8", theme.brass, buildStroke(0.9f, roundCap = false))
        }
        Accessory.Bowtie -> {
            fillSvgPath(
                "M24 38.6l-5.2-2.8c-.7-.4-1.4 0-1.4.8v4c0 .8.7 1.2 1.4.8zM24 38.6l5.2-2.8c.7-.4 1.4 0 1.4.8v4c0 .8-.7 1.2-1.4.8z",
                theme.hat,
            )
            drawSvgRect(22.4f, 37f, 3.2f, 3.2f, 1f, theme.hat)
            drawSvgRect(22.4f, 37f, 3.2f, 3.2f, 1f, paints.who.who, buildStroke(0.7f, roundCap = false))
        }
        // A pocket watch on a brass chain.
        Accessory.Watch -> {
            strokeSvgPath("M24.4 37.2c2 1.4 4.8 1.6 7 .6", theme.brass, buildStroke(1f))
            drawSvgCircle(33.4f, 37.8f, 2.7f, theme.brass)
            drawSvgCircle(33.4f, 37.8f, 1.7f, WatchFaceColor)
            strokeSvgPath("M33.4 36.9v.9l.6.4", theme.faceInk, buildStroke(0.5f))
        }
    }
}

/** Draws an assistant's [headwear] over the body and its accessories, on a body whose top is at [topY]. */
internal fun DrawScope.drawHeadwear(headwear: Headwear, topY: Double, paints: FacePaints) {
    val hat = paints.theme.hat
    when (headwear) {
        // A 1920s bell hat pulled down to the brows, with a rosette on the band.
        Headwear.Cloche -> {
            val y = { dy: Double -> formatHatY(topY, dy) }
            val bell = "M9.2 ${y(13.6)}" +
                "C9.6 ${y(3.0)} 15.4 ${y(-2.0)} 24 ${y(-2.0)}" +
                "S38.4 ${y(3.0)} 38.8 ${y(13.6)}" +
                "C35 ${y(11.4)} 30 ${y(10.6)} 24 ${y(10.6)}" +
                "S13 ${y(11.4)} 9.2 ${y(13.6)}z"
            val band = "M10.2 ${y(9.4)}C15.6 ${y(7.0)} 32.4 ${y(7.0)} 37.8 ${y(9.4)}"
            val rosetteY = roundToHundredths(topY + 7.9).toFloat()
            fillSvgPath(bell, hat)
            strokeSvgPath(band, paints.who.whoShade, buildStroke(2f, roundCap = false))
            drawSvgCircle(32.8f, rosetteY, 2.4f, paints.who.whoShade)
            drawSvgCircle(32.8f, rosetteY, 0.9f, hat)
        }
        // A beret tilted to one side, with its stalk on top. crew.js leaves these numbers unrounded.
        Headwear.Beret -> {
            val crownY = topY + 1.8
            drawSvgEllipse(22.6f, crownY.toFloat(), 12.6f, 4.6f, hat, rotation = -9f)
            strokeSvgPath("M21.4 ${formatSvgNumber(topY - 2.4)}l.6-2.6", hat, buildStroke(1.8f))
        }
        // A band over the head, an earpiece on the left and a microphone on a boom to the mouth.
        // The band's control points sit 1 above the top of the body, unrounded as in crew.js.
        Headwear.Headset -> {
            val bandY = formatSvgNumber(topY - 1)
            strokeSvgPath("M9.4 26.4C9 $bandY 39 $bandY 38.6 26.4", hat, buildStroke(1.9f, roundCap = false))
            drawSvgRect(6.2f, 23f, 5.6f, 9.2f, 2.6f, hat)
            strokeSvgPath("M9.4 31.6c.6 3 3.2 4.8 7.4 5.2", hat, buildStroke(1.5f))
            drawSvgCircle(17.4f, 36.8f, 1.7f, hat)
        }
    }
}

// Literal colours in the desktop's accessories.tsx.
private val MonocleGlassColor = Color.White.copy(alpha = 0.18f)
private val WatchFaceColor = oklch(0.97f, 0.02f, 90f)
