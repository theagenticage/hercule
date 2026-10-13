package dev.hercule.android.theme

import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import dev.hercule.android.R

/** The book's regular, medium and bold weights (`--w-regular`, `--w-medium`, `--w-bold` in tokens.css). */
val RegularWeight = FontWeight(400)
val MediumWeight = FontWeight(520)
val BoldWeight = FontWeight(640)

/**
 * Returns Bricolage Grotesque, the face of all interface text (`--font-ui`), cut for text drawn
 * at [size] sp.
 *
 * The file is a variable font whose default instance is the 96 pt ExtraBold display cut, so
 * every weight sets its `wght` axis explicitly. The book lets the browser follow the font size
 * with the `opsz` axis (`font-optical-sizing: auto`), so small text gets the open, sturdy text
 * cut and a 28 px title the tighter display cut. Compose fixes a font's axes when the family is
 * built, so there is one family per size, built once and kept.
 */
fun buildUiFontFamily(size: TextUnit): FontFamily {
    val opticalSize = size.value.coerceIn(MIN_OPTICAL_SIZE, MAX_OPTICAL_SIZE)
    return uiFontFamilies.getOrPut(opticalSize) {
        FontFamily(
            buildBricolageFont(RegularWeight, opticalSize),
            buildBricolageFont(MediumWeight, opticalSize),
            buildBricolageFont(BoldWeight, opticalSize),
        )
    }
}

// The range of Bricolage Grotesque's `opsz` axis.
private const val MIN_OPTICAL_SIZE = 12f
private const val MAX_OPTICAL_SIZE = 96f

// Every family built so far, by optical size. The app draws a dozen sizes, and Compose builds
// text on the main thread only, so a plain map is enough.
private val uiFontFamilies = HashMap<Float, FontFamily>()

/** Limelight, used only for the wordmark, the logo lettering and large numerals (`--font-deco`). */
val DecoFontFamily = FontFamily(Font(R.font.limelight))

/**
 * Recursive, used only for code, diffs, commands and branch names (`--font-mono`).
 *
 * The axes are the book's `--mono-axes`: monospaced, half casual, no cursive forms.
 */
val MonoFontFamily = FontFamily(
    Font(
        R.font.recursive,
        weight = RegularWeight,
        variationSettings = FontVariation.Settings(
            FontVariation.weight(RegularWeight.weight),
            FontVariation.Setting("MONO", 1f),
            FontVariation.Setting("CASL", 0.5f),
            FontVariation.Setting("CRSV", 0f),
        ),
    ),
)

/** Returns the Bricolage Grotesque font at [weight], cut for text of [opticalSize] points. */
private fun buildBricolageFont(weight: FontWeight, opticalSize: Float) = Font(
    R.font.bricolage_grotesque,
    weight = weight,
    variationSettings = FontVariation.Settings(
        FontVariation.weight(weight.weight),
        FontVariation.Setting("opsz", opticalSize),
    ),
)
