package dev.hercule.android.theme

import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import dev.hercule.android.R

/** The book's regular, medium and bold weights (`--w-regular`, `--w-medium`, `--w-bold` in tokens.css). */
val RegularWeight = FontWeight(400)
val MediumWeight = FontWeight(520)
val BoldWeight = FontWeight(640)

/**
 * Bricolage Grotesque, the face of all interface text (`--font-ui`).
 *
 * The file is a variable font whose default instance is the 96 pt ExtraBold display cut, so
 * every weight sets its `wght` axis explicitly, and `opsz` is set to the interface text size.
 */
val UiFontFamily = FontFamily(
    buildBricolageFont(RegularWeight),
    buildBricolageFont(MediumWeight),
    buildBricolageFont(BoldWeight),
)

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

/** Returns the Bricolage Grotesque font at the given weight, sized for interface text. */
private fun buildBricolageFont(weight: FontWeight) = Font(
    R.font.bricolage_grotesque,
    weight = weight,
    variationSettings = FontVariation.Settings(
        FontVariation.weight(weight.weight),
        // The book lets the browser track `opsz` to the font size (font-optical-sizing: auto).
        // Interface text sits at 13 to 15 px, so 14 matches it.
        FontVariation.Setting("opsz", 14f),
    ),
)
