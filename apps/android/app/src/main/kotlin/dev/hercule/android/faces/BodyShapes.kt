package dev.hercule.android.faces

// A port of apps/desktop/src/renderer/faces/shapes.ts. Coordinates are in the units of the
// face's 45-unit drawing, whose box starts at x 3, y 1 (the SVG viewBox "3 1 45 45").

/**
 * The measurements of a body shape. Every shape is an egg centred on x 24.
 * - [topY]: the y of the top of the head.
 * - [bottomY]: the y of the base.
 * - [widestY]: the y of the widest point, below the middle, so the body sits firmly on its base.
 * - [halfWidth]: half the body's width at its widest point.
 */
data class BodyMetrics(val topY: Double, val bottomY: Double, val widestY: Double, val halfWidth: Double)

/** Returns the measurements of [shape], as the Bureau book's crew.js gives them. */
fun readBodyMetrics(shape: BodyShape): BodyMetrics = when (shape) {
    BodyShape.Egg -> BodyMetrics(topY = 9.6, bottomY = 42.4, widestY = 30.5, halfWidth = 14.4)
    BodyShape.Tall -> BodyMetrics(topY = 8.4, bottomY = 42.4, widestY = 31.0, halfWidth = 12.8)
    BodyShape.Round -> BodyMetrics(topY = 11.0, bottomY = 42.4, widestY = 29.5, halfWidth = 15.4)
    BodyShape.Wide -> BodyMetrics(topY = 12.6, bottomY = 42.4, widestY = 31.0, halfWidth = 16.2)
}

/**
 * Rounds a coordinate to two decimals, as crew.js rounds the numbers it writes into a path.
 * It uses [Math.round], which rounds a tie up as JavaScript's `Math.round` does;
 * `kotlin.math.round` rounds a tie to even and would differ.
 */
fun roundToHundredths(value: Double): Double = Math.round(value * 100) / 100.0

/**
 * Formats a number as JavaScript writes it into a string: a whole number without ".0", any
 * other number as its shortest exact decimal. The face's paths are the desktop's path strings,
 * number for number, so a test can compare them with the book's.
 */
fun formatSvgNumber(value: Double): String =
    if (value == Math.rint(value)) value.toLong().toString() else value.toString()

/**
 * Builds the SVG path of the body of [shape]: an egg outline from the shape's top, bottom, widest
 * height and half-width. The values are rounded where crew.js rounds them and left unrounded
 * where it does not, which is why the wide shape's left edge is 7.800000000000001: the path
 * equals the book's string.
 */
fun buildBodyPath(shape: BodyShape): String {
    val (topY, bottomY, widestY, halfWidth) = readBodyMetrics(shape)
    val up = widestY - topY
    val down = bottomY - widestY
    val right = formatSvgNumber(24 + halfWidth)
    val left = formatSvgNumber(24 - halfWidth)
    val top = formatSvgNumber(roundToHundredths(topY))
    val bottom = formatSvgNumber(roundToHundredths(bottomY))
    val widest = formatSvgNumber(roundToHundredths(widestY))
    val upperControlY = formatSvgNumber(roundToHundredths(widestY - up * 0.52))
    val lowerControlY = formatSvgNumber(roundToHundredths(widestY + down * 0.62))
    val topRightControlX = formatSvgNumber(roundToHundredths(24 + halfWidth * 0.6))
    val topLeftControlX = formatSvgNumber(roundToHundredths(24 - halfWidth * 0.6))
    val bottomRightControlX = formatSvgNumber(roundToHundredths(24 + halfWidth * 0.7))
    val bottomLeftControlX = formatSvgNumber(roundToHundredths(24 - halfWidth * 0.7))
    // Four curves, clockwise from the top: the upper right, lower right, lower left and upper left quarter.
    return "M24 $top" +
        "C$topRightControlX $top $right $upperControlY $right $widest" +
        "C$right $lowerControlY $bottomRightControlX $bottom 24 $bottom" +
        "C$bottomLeftControlX $bottom $left $lowerControlY $left $widest" +
        "C$left $upperControlY $topLeftControlX $top 24 ${top}Z"
}
