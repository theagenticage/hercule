package dev.hercule.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.hercule.android.faces.oklch
import dev.hercule.android.theme.BureauColors
import dev.hercule.android.theme.MonoFontFamily
import dev.hercule.android.theme.OrientExpressColors
import dev.hercule.android.theme.RegularWeight
import dev.hercule.android.theme.WhitehavenColors
import dev.hercule.android.theme.buildUiFontFamily

/** The colours of the theme in use. [BureauTheme] provides them; outside it, Whitehaven's. */
val LocalBureauColors = staticCompositionLocalOf { WhitehavenColors }

/** Whether the theme in use is the dark one, Orient Express. It picks the book's shadow colour. */
private val LocalDarkTheme = staticCompositionLocalOf { false }

/** The colours of the theme in use, read inside a composable. */
val bureauColors: BureauColors
    @Composable @ReadOnlyComposable get() = LocalBureauColors.current

/**
 * Draws [content] in the book's theme: Whitehaven when the system is light, Orient Express when
 * it is dark. The app offers no other theme and no switch of its own.
 *
 * Material 3 is used only for its primitives (text fields, ripples, the cursor), so its colour
 * scheme is filled from the book's tokens and never seen as Material's palette. Text drawn
 * without a style of its own is the book's body text: 13 sp ink at line height 1.45.
 */
@Composable
fun BureauTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (dark) OrientExpressColors else WhitehavenColors
    val scheme = if (dark) darkColorScheme() else lightColorScheme()
    MaterialTheme(
        colorScheme = scheme.copy(
            primary = colors.accent,
            onPrimary = colors.accentFg,
            background = colors.bg,
            onBackground = colors.ink,
            surface = colors.surface,
            onSurface = colors.ink,
            error = colors.fail,
        ),
    ) {
        CompositionLocalProvider(
            LocalBureauColors provides colors,
            LocalDarkTheme provides dark,
            LocalContentColor provides colors.ink,
            LocalTextStyle provides buildUiTextStyle(13.sp),
            LocalTextSelectionColors provides TextSelectionColors(colors.accent, colors.accent.copy(alpha = 0.3f)),
            content = content,
        )
    }
}

/**
 * Returns the book's interface text style at [size]: Bricolage Grotesque cut for that size,
 * at [weight], with [lineHeight] as a multiple of the size, as CSS writes `line-height: 1.45`.
 *
 * The extra line height is shared above and below the text, as a browser shares it, so a line
 * sits where the book's line sits.
 */
fun buildUiTextStyle(
    size: TextUnit,
    weight: FontWeight = RegularWeight,
    lineHeight: Float = 1.45f,
    letterSpacing: TextUnit = 0.em,
) = TextStyle(
    fontFamily = buildUiFontFamily(size),
    fontWeight = weight,
    fontSize = size,
    lineHeight = lineHeight.em,
    letterSpacing = letterSpacing,
    lineHeightStyle = CssLineHeightStyle,
)

/** Returns the book's code text style at [size]: Recursive, monospaced, at [lineHeight]. */
fun buildMonoTextStyle(size: TextUnit, lineHeight: Float = 1.45f) = TextStyle(
    fontFamily = MonoFontFamily,
    fontWeight = RegularWeight,
    fontSize = size,
    lineHeight = lineHeight.em,
    lineHeightStyle = CssLineHeightStyle,
)

private val CssLineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)

/** The book's two card shadows, `--shadow-1` (resting) and `--shadow-2` (lifted). */
enum class BureauElevation { Resting, Lifted }

/**
 * Draws the book's `--shadow-1` or `--shadow-2` under the element, in the theme's shadow colour:
 * a green-grey ink in Whitehaven and black in Orient Express.
 */
@Composable
fun Modifier.bureauShadow(elevation: BureauElevation, shape: Shape): Modifier {
    val dark = LocalDarkTheme.current
    // Each shadow is two CSS layers: a tight contact shadow and a wider soft one.
    val ink = if (dark) Color.Black else oklch(0.3f, 0.03f, 165f)
    return when (elevation) {
        BureauElevation.Resting -> this
            .dropShadow(shape, Shadow(radius = 1.dp, color = ink, alpha = if (dark) 0.25f else 0.05f, offset = DpOffset(0.dp, 1.dp)))
            .dropShadow(shape, Shadow(radius = 3.dp, color = ink, alpha = if (dark) 0.2f else 0.06f, offset = DpOffset(0.dp, 1.dp)))
        BureauElevation.Lifted -> this
            .dropShadow(shape, Shadow(radius = 2.dp, color = ink, alpha = if (dark) 0.3f else 0.06f, offset = DpOffset(0.dp, 1.dp)))
            .dropShadow(
                shape,
                Shadow(
                    radius = if (dark) 28.dp else 24.dp,
                    spread = (-8).dp,
                    color = ink,
                    alpha = if (dark) 0.45f else 0.16f,
                    offset = DpOffset(0.dp, if (dark) 10.dp else 8.dp),
                ),
            )
    }
}
