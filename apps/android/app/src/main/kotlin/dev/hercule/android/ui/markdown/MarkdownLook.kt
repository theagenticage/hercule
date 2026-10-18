package dev.hercule.android.ui.markdown

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.ui.InlineCodeStyle
import dev.hercule.android.ui.LocalDarkTheme
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.buildMonoTextStyle
import dev.hercule.android.ui.buildUiTextStyle

/*
 * The sizes a message's markdown is drawn at on the phone, taken over from the desktop's
 * apps/desktop/src/renderer/screens/session/markdown.css.
 *
 * The book's phone pages draw a message's text at 15 px with line height 1.5, where the
 * desktop draws 14 px at 1.6 (`.phone .msg-body` in docs/design/crew-bureau-2/system.css). The
 * book changes nothing else for the phone but the code block, so the mapping is:
 *
 * - Text sizes go up one step with the body: the desktop's 14 px text (paragraphs, headings,
 *   a details summary) is 15 sp, and its 13 px text (tables, footnotes) is 14 sp. Every line
 *   height is the phone's 1.5, except a heading's own 1.45.
 * - Inline code stays 12.5 sp on its chip, as the book's phone pages draw it.
 * - Weights are the desktop's: a heading is the book's `--w-bold` (640), and strong text and a
 *   table's header cells the browser's bold (700), which `<strong>` and `<th>` take there.
 * - Spacing keeps the desktop's numbers, a CSS px becoming a dp, because the book keeps the
 *   paragraph margin of 10 px on the phone: a block's 10 dp margin, a heading's 16 dp above and
 *   6 dp below, a rule's 14 dp, a list's 22 dp indent, a quote's 12 dp indent and 2 dp line,
 *   a table cell's 4 dp above and below and 12 dp after, a details block's 14 dp indent.
 * - The code block takes the book's own phone values (`.phone .codeblock`): 11.5 sp at line
 *   height 1.6, padded 10 by 12 dp, 8 dp above and below.
 *
 * Margins collapse as CSS margins do: two blocks in a row are as far apart as the larger of the
 * two margins between them, and a container with no padding of its own (a quote, a list item)
 * passes its first child's top margin and its last child's bottom margin out to its siblings.
 * See [computeMargins].
 */

/** The text and colours a message's markdown is drawn with, from the theme in use. */
@Immutable
internal data class MarkdownLook(
    /** A paragraph's text, the book's `.msg-body`: 15 sp ink at line height 1.5. */
    val body: TextStyle,
    /** A table's and the footnotes' text: 14 sp at line height 1.5, in the colour around it. */
    val small: TextStyle,
    /** A code block's text: Recursive at 11.5 sp, line height 1.6, in ink. */
    val codeBlock: TextStyle,
    val muted: Color,
    val faint: Color,
    val ink: Color,
    /** A quote's line and a link's underline, `--line`. */
    val line: Color,
    /** A rule, a table's hairlines and the code block's rim, `--line-soft`. */
    val lineSoft: Color,
    /** The code block's background, `--sunken`. */
    val sunken: Color,
    /** The greys of a task box, which are Chromium's own and not the theme's. */
    val checkbox: CheckboxColors,
    /** The inline code chip's background, `color-mix(in oklab, var(--ink) 6%, transparent)`. */
    val chip: Color,
)

/** Returns the [MarkdownLook] of the theme in use. */
@Composable
@ReadOnlyComposable
internal fun readMarkdownLook(): MarkdownLook {
    val colors = bureauColors
    return MarkdownLook(
        body = buildUiTextStyle(15.sp, lineHeight = 1.5f).copy(color = colors.ink),
        small = buildUiTextStyle(14.sp, lineHeight = 1.5f),
        codeBlock = buildMonoTextStyle(11.5.sp, lineHeight = 1.6f).copy(color = colors.ink),
        muted = colors.muted,
        faint = colors.faint,
        ink = colors.ink,
        line = colors.line,
        lineSoft = colors.lineSoft,
        sunken = colors.sunken,
        checkbox = if (LocalDarkTheme.current) DARK_CHECKBOX else LIGHT_CHECKBOX,
        chip = colors.ink.copy(alpha = 0.06f),
    )
}

/**
 * The colours of a read-only task box: a ticked box's [fill] and [tick], and an empty box's
 * [empty] inside and [rim]. Chromium draws a disabled checkbox in greys of its own for each
 * colour scheme, whatever the page's colours, and these are those greys, read from the desktop.
 */
@Immutable
internal data class CheckboxColors(val fill: Color, val tick: Color, val empty: Color, val rim: Color)

private val LIGHT_CHECKBOX = CheckboxColors(fill = Color(0xFFD0D0D0), tick = Color.White, empty = Color(0xFFF8F8F7), rim = Color(0xFFD0D0D0))

private val DARK_CHECKBOX = CheckboxColors(fill = Color(0xFF757575), tick = Color(0xFF3B3B3B), empty = Color(0xFF3B3B3B), rim = Color(0xFF626262))

/** Returns a heading's style, the desktop's `font-size: var(--t-14); line-height: 1.45`, bold, in [color]. */
internal fun buildHeadingStyle(color: Color): TextStyle = buildUiTextStyle(15.sp, BoldWeight, lineHeight = 1.45f).copy(color = color)

/**
 * Returns how inline code is drawn inside text of [color]: the book's `code`, Recursive at
 * 12.5 sp on a rounded chip, padded 5 dp on each side. The code takes the colour of the text
 * around it, as CSS gives `code` no colour of its own.
 */
internal fun MarkdownLook.buildCodeStyle(color: Color) = InlineCodeStyle(12.5.sp, color, chip, padding = 5.dp, radius = 5.dp)
