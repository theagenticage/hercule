package dev.hercule.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hercule.android.faces.Face
import dev.hercule.android.faces.Look
import dev.hercule.android.faces.buildAssistantLook
import dev.hercule.android.faces.buildLook
import dev.hercule.android.faces.selectCrewColors
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.theme.BureauColors
import dev.hercule.android.theme.CrewColors
import dev.hercule.android.theme.MediumWeight
import dev.hercule.android.theme.RegularWeight
import dev.hercule.android.wire.Project

/** A one-pixel rule in the soft line colour, as the book's `border-bottom: 1px solid var(--line-soft)`. */
@Composable
fun Hairline(modifier: Modifier = Modifier, color: Color = bureauColors.lineSoft) {
    Box(modifier.fillMaxWidth().height(1.dp).background(color))
}

/**
 * Draws a count pill, the book's `.count`: [count] in small bold figures. A count of things that
 * wait on the user ([waiting]) is marigold, the one colour that means "you".
 */
@Composable
fun CountPill(count: Int, waiting: Boolean, modifier: Modifier = Modifier) {
    val colors = bureauColors
    Box(
        modifier
            .defaultMinSize(minWidth = 20.dp)
            .height(18.dp)
            .background(if (waiting) colors.you else colors.ink.copy(alpha = 0.07f), RoundedCornerShape(50))
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            count.toString(),
            style = buildUiTextStyle(11.sp, BoldWeight, lineHeight = 1f),
            color = if (waiting) colors.faceInk else colors.muted,
        )
    }
}

/** The three looks of the book's `.btn`: plain, the accent for the one suggested answer, and quiet. */
enum class ButtonLook { Plain, Accent, Quiet }

/**
 * The sizes of the book's buttons: [Small] is `.btn--sm`, [Regular] is `.btn`, and [Large] is the
 * phone's thumb-sized answer button (office.html's `.ask-go .btn`), 46 dp tall.
 */
enum class ButtonSize(val height: Dp, val radius: Dp, val padding: Dp, val textSize: TextUnit) {
    Small(26.dp, 7.dp, 10.dp, 12.sp),
    Regular(30.dp, 7.dp, 12.dp, 13.sp),
    Large(46.dp, 14.dp, 16.dp, 15.sp),
}

/**
 * Draws a button as the book's `.btn` draws it: [label] in [look] at [size]. A button that is not
 * [enabled] is drawn at half opacity and does nothing, as the book draws a button that cannot act
 * now.
 */
@Composable
fun BureauButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    look: ButtonLook = ButtonLook.Plain,
    size: ButtonSize = ButtonSize.Regular,
    enabled: Boolean = true,
) {
    val colors = bureauColors
    val shape = RoundedCornerShape(size.radius)
    val surface = when (look) {
        ButtonLook.Plain -> Modifier.background(colors.btnFill, shape).border(1.dp, colors.btnRim, shape)
        // The book rims the accent with the accent mixed 20% towards black.
        ButtonLook.Accent -> Modifier.background(colors.accent, shape).border(1.dp, lerp(colors.accent, Color.Black, 0.2f), shape)
        ButtonLook.Quiet -> Modifier
    }
    Box(
        modifier
            .alpha(if (enabled) 1f else 0.5f)
            .height(size.height)
            .clip(shape)
            .then(surface)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = size.padding),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = buildUiTextStyle(size.textSize, if (look == ButtonLook.Accent) BoldWeight else MediumWeight, lineHeight = 1f),
            color = when (look) {
                ButtonLook.Plain -> colors.ink
                ButtonLook.Accent -> colors.accentFg
                ButtonLook.Quiet -> colors.muted
            },
            maxLines = 1,
        )
    }
}

/**
 * Draws a 28 dp square icon button, the book's `.icon-btn`, with [icon] at [iconSize] in the
 * muted colour. A button that is not [enabled] is drawn at half opacity and does nothing.
 */
@Composable
fun IconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    iconSize: Dp = 20.dp,
    enabled: Boolean = true,
) {
    Box(
        modifier
            .size(28.dp)
            .alpha(if (enabled) 1f else 0.5f)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = contentDescription, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        BureauIcon(icon, bureauColors.muted, size = iconSize)
    }
}

/**
 * Returns the rug tint of [project]: the book's three project tints, picked by the project's
 * position in [projects], counted round the three. This is client-core's `pickProjectHue` with
 * the desktop's tints, so a project has the same tint in both apps.
 */
fun pickProjectTint(project: Project, projects: List<Project>, colors: BureauColors): Color {
    val tints = listOf(colors.projWebshop, colors.projPayments, colors.projOps)
    val index = projects.indexOfFirst { it.id == project.id }
    return if (index < 0) tints[0] else tints[index % tints.size]
}

/**
 * Draws a project's name after its rug swatch, the book's `.proj`: an 11 dp square turned 45
 * degrees, in the project's [tint] with a faint ink edge, then [name] in [nameColor].
 */
@Composable
fun ProjectLabel(name: String, tint: Color, nameColor: Color, modifier: Modifier = Modifier, bold: Boolean = true) {
    val colors = bureauColors
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        val shape = RoundedCornerShape(3.5.dp)
        Box(
            Modifier
                .size(11.dp)
                .rotate(45f)
                .scale(0.9f)
                .background(tint, shape)
                .border(1.dp, colors.ink.copy(alpha = 0.14f), shape),
        )
        Text(name, style = buildUiTextStyle(12.sp, if (bold) MediumWeight else RegularWeight), color = nameColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Draws the top bar of a pushed screen, the book's `.m-nav`: a 52 dp row with the back button in
 * a 64 dp column on the left, [head] centred, and [trailing] in a 64 dp column on the right,
 * over a soft hairline.
 */
@Composable
fun NavBar(
    onBack: () -> Unit,
    backLabel: String,
    head: @Composable RowScope.() -> Unit,
    modifier: Modifier = Modifier,
    backText: String? = null,
    backBadge: Int? = null,
    trailing: @Composable () -> Unit = {},
) {
    val colors = bureauColors
    Box(modifier.fillMaxWidth().height(52.dp).padding(horizontal = 8.dp)) {
        Row(
            Modifier
                .align(Alignment.CenterStart)
                .height(44.dp)
                .clickable(role = Role.Button, onClickLabel = backLabel, onClick = onBack),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            BureauIcon(BureauIcons.ChevronLeft, colors.ink, size = 22.dp)
            if (backText != null) Text(backText, style = buildUiTextStyle(16.sp, lineHeight = 1.2f), color = colors.ink)
            if (backBadge != null) YouBadge(backBadge, Modifier.padding(start = 2.dp))
        }
        Row(
            Modifier.align(Alignment.Center).padding(horizontal = 64.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            content = head,
        )
        Box(Modifier.align(Alignment.CenterEnd)) { trailing() }
    }
    Hairline()
}

/** Draws the marigold badge the book puts on a tab or a back button, `.tb-badge`, holding [count]. */
@Composable
fun YouBadge(count: Int, modifier: Modifier = Modifier) {
    val colors = bureauColors
    Box(
        modifier
            .defaultMinSize(minWidth = 17.dp)
            .height(17.dp)
            .background(colors.you, RoundedCornerShape(9.dp))
            .padding(horizontal = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(count.toString(), style = buildUiTextStyle(10.5.sp, lineHeight = 1f), color = colors.faceInk)
    }
}

/**
 * Draws [face] at [size]: an assistant's look, with its headwear, or a thread's look. [badgeRing]
 * is the colour behind the face, as [Face] takes it.
 */
@Composable
fun ColleagueFace(face: OfficeFace, size: Dp, modifier: Modifier = Modifier, badgeRing: Color = bureauColors.surface) {
    val look = remember(face.seed, face.isAssistant) { buildFaceLook(face) }
    Face(look, face.pose, size, bureauColors, modifier, badgeRing)
}

/** Returns the colours of [face]'s hue, such as `whoInk` for writing its name and `whoTint` behind it. */
@Composable
fun pickCrewColors(face: OfficeFace): CrewColors {
    val look = remember(face.seed, face.isAssistant) { buildFaceLook(face) }
    return selectCrewColors(bureauColors.crew, look.hue)
}

/** Builds the look of [face]: with headwear for an assistant, without for a thread. */
private fun buildFaceLook(face: OfficeFace): Look =
    if (face.isAssistant) buildAssistantLook(face.seed) else buildLook(face.seed)
