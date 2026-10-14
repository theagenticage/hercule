package dev.hercule.android.ui.office

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import dev.hercule.android.faces.Pose
import dev.hercule.android.office.Office
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.office.OfficeField
import dev.hercule.android.office.OfficeLane
import dev.hercule.android.office.OfficeLaneKind
import dev.hercule.android.office.OfficeRow
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.theme.BureauScales
import dev.hercule.android.theme.MediumWeight
import dev.hercule.android.theme.RegularWeight
import dev.hercule.android.ui.BureauButton
import dev.hercule.android.ui.BureauElevation
import dev.hercule.android.ui.ButtonLook
import dev.hercule.android.ui.ButtonSize
import dev.hercule.android.ui.CodeText
import dev.hercule.android.ui.ColleagueRow
import dev.hercule.android.ui.ColleagueFace
import dev.hercule.android.ui.CountPill
import dev.hercule.android.ui.Hairline
import dev.hercule.android.ui.InlineCodeStyle
import dev.hercule.android.ui.LaneHead
import dev.hercule.android.ui.LaneTitle
import dev.hercule.android.ui.ProjectLabel
import dev.hercule.android.ui.Tab
import dev.hercule.android.ui.TabBar
import dev.hercule.android.ui.buildUiTextStyle
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.bureauShadow
import dev.hercule.android.ui.drawTopHairline
import dev.hercule.android.ui.glassShadow
import dev.hercule.android.ui.pickProjectTint
import dev.hercule.android.ui.thread.buildDockTitle
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.ApprovalRequest
import dev.hercule.android.wire.Project

/**
 * What the Office screen draws: the [office] from `buildOffice`, the [projects] that tint each
 * project's rug, the [answeredRequestIds] whose answer was sent from here and has not failed,
 * and [waitingCount], how many threads wait on the user, on the tab bar's Threads tab.
 */
data class OfficeUiState(val office: Office, val projects: List<Project>, val answeredRequestIds: Set<String>, val waitingCount: Int)

/**
 * Draws the Office, the book's mobile/office.html: the title and the receipt, the plan of
 * runners and the Lobby, then the lanes, and the tab bar.
 *
 * The first row of Waiting on you is drawn as the ask card when its Request is an approval, so
 * it can be answered from here: [onDecide] gets the row and the decision. [onOpen] opens a row's
 * thread or assistant; [onSelectTab] switches tabs.
 */
@Composable
fun OfficeScreen(
    state: OfficeUiState,
    onOpen: (OfficeRow) -> Unit,
    onDecide: (OfficeRow, ApprovalDecision) -> Unit,
    onSelectTab: (Tab) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = bureauColors
    val office = state.office
    Column(modifier.fillMaxSize().background(colors.bg)) {
        Column(Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top))) {
            // The hairline runs to the screen's edges; the text keeps clear of the cutout.
            Column(Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))) {
                Text(
                    "Office",
                    Modifier.padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 10.dp),
                    style = buildUiTextStyle(28.sp, BoldWeight, letterSpacing = (-0.02).em),
                    color = colors.ink,
                )
                Receipt(office)
            }
            Hairline()
        }
        LazyColumn(
            // In landscape the rows keep clear of the camera cutout and the side navigation bar,
            // as the title above them does.
            Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 14.dp, bottom = 20.dp),
        ) {
            item(key = "plan") { Plan(office.fields, office.lobby, onOpen) }
            office.lanes.forEach { lane ->
                item(key = "lane-${lane.kind}") { OfficeLaneHead(lane) }
                itemsIndexed(lane.rows, key = { _, row -> "row-${row.sessionId}-${row.assistantId}" }) { index, row ->
                    val request = row.request
                    val previousIsAsk = index == 1 && lane.kind == OfficeLaneKind.Waiting && lane.rows[0].request is ApprovalRequest
                    when {
                        index == 0 && lane.kind == OfficeLaneKind.Waiting && request is ApprovalRequest ->
                            AskCard(row, request, findRunnerName(office.fields, row), state.projects, request.requestId in state.answeredRequestIds, onOpen, onDecide)
                        // The book's `.ask + .row` puts a gap under the ask card, and `.row + .row` a line between two rows.
                        previousIsAsk -> OfficeRowLine(row, state.projects, onOpen, Modifier.padding(top = 6.dp))
                        else -> OfficeRowLine(row, state.projects, onOpen, if (index > 0) Modifier.drawTopHairline(colors.lineSoft) else Modifier)
                    }
                }
            }
        }
        TabBar(Tab.Office, state.waitingCount, onSelectTab)
    }
}

/** Draws the receipt, the book's `.receipt`: one count per lane, the waiting count bold in the waiting colour. */
@Composable
private fun Receipt(office: Office) {
    val colors = bureauColors
    val waitingFirst = office.lanes.firstOrNull()?.kind == OfficeLaneKind.Waiting
    Text(
        buildAnnotatedString {
            office.receipt.forEachIndexed { index, part ->
                if (index > 0) append("  ·  ")
                if (index == 0 && waitingFirst) {
                    withStyle(SpanStyle(color = colors.youInk, fontWeight = BoldWeight)) { append(part) }
                } else {
                    append(part)
                }
            }
        },
        Modifier.padding(start = 20.dp, end = 20.dp, bottom = 12.dp),
        style = buildUiTextStyle(12.sp),
        color = colors.muted,
    )
}

/**
 * Draws the plan, the book's `.plan`: a wing per runner and the Lobby, two to a row. An asleep
 * assistant has no row in the lanes, so the Lobby is where [onOpen] opens one.
 */
@Composable
private fun Plan(fields: List<OfficeField>, lobby: List<OfficeRow>, onOpen: (OfficeRow) -> Unit) {
    val colors = bureauColors
    val wingColor = lerp(colors.roomFloor, colors.roomInlay, 0.22f)
    val wings = fields.map { field -> WingContent(field.faces, field.runner.name, field.capacity, wingColor) } +
        listOfNotNull(
            lobby.takeIf { it.isNotEmpty() }?.let { rows ->
                WingContent(rows.map { it.face }, "Lobby", rows.joinToString(", ") { it.title } + ", asleep", colors.roomFloor, opens = rows)
            },
        )
    Column(Modifier.padding(bottom = 2.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        wings.chunked(2).forEach { pair ->
            // Both wings of a row take the height of the taller one, as the book's grid rows do.
            Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                pair.forEach { Wing(it, onOpen, Modifier.weight(1f).fillMaxHeight()) }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

/**
 * What one wing of the plan shows: its faces, its name and its note, on [background]. [opens]
 * holds the colleague behind each face when a tap on the wing opens them, which only the
 * Lobby's does; it is empty otherwise.
 */
private data class WingContent(
    val faces: List<OfficeFace>,
    val name: String,
    val note: String,
    val background: Color,
    val opens: List<OfficeRow> = emptyList(),
)

/**
 * Draws one wing, the book's `.wing`: up to four faces with a "+N" for the rest, then the name
 * and the note, inside the desktop wing's double inlay line.
 *
 * The book sets the name and the note on one line, with a note as short as "8 of 8 · at cap".
 * The app's note is the desktop's capacity line, such as "8 running of 8", which does not fit
 * beside a runner's name in half of a 390 dp phone. So the note sits on its own line under the
 * name, in every wing, so all wings share one layout. The wing is at least the book's 84 dp and
 * grows to fit its text, so neither the name nor the note is ever cut off.
 *
 * A wing that [WingContent.opens] one colleague opens them on a tap anywhere on it. With several,
 * each of the first four faces opens its own colleague, and "+N" opens a menu of the others.
 */
@Composable
private fun Wing(wing: WingContent, onOpen: (OfficeRow) -> Unit, modifier: Modifier) {
    val colors = bureauColors
    val shape = RoundedCornerShape(14.dp)
    val opensWholeWing = wing.opens.singleOrNull()
    val taps = remember { MutableInteractionSource() }
    val tapModifier = if (opensWholeWing != null) {
        Modifier.clickable(taps, indication = null, role = Role.Button, onClickLabel = "Open ${opensWholeWing.title}") { onOpen(opensWholeWing) }
    } else {
        Modifier
    }
    Box(modifier.heightIn(min = 84.dp).background(wing.background, shape).then(tapModifier)) {
        // The ripple is drawn in a layer of its own, clipped to the rounded corners. Clipping the
        // wing itself would redraw the edges of its background.
        if (opensWholeWing != null) Box(Modifier.matchParentSize().clip(shape).indication(taps, ripple()))
        Box(Modifier.matchParentSize().padding(4.dp).border(1.dp, colors.roomInlay2.copy(alpha = 0.3f), RoundedCornerShape(10.dp)))
        Box(Modifier.matchParentSize().padding(7.dp).border(1.dp, colors.roomInlay2.copy(alpha = 0.18f), RoundedCornerShape(8.dp)))
        Column(
            Modifier.fillMaxHeight().padding(start = 13.dp, end = 13.dp, top = 13.dp, bottom = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                wing.faces.take(4).forEachIndexed { index, face ->
                    val opensFace = wing.opens.getOrNull(index)?.takeIf { wing.opens.size > 1 }
                    ColleagueFace(
                        face,
                        30.dp,
                        Modifier.offset(x = (-6 * index).dp).then(
                            if (opensFace == null) Modifier else Modifier.clickable(role = Role.Button, onClickLabel = "Open ${opensFace.title}") { onOpen(opensFace) },
                        ),
                        badgeRing = wing.background,
                    )
                }
                if (wing.faces.size > 4) {
                    val opensHidden = if (wing.opens.size > 4) wing.opens.drop(4) else emptyList()
                    var isMenuOpen by remember { mutableStateOf(false) }
                    val pill = RoundedCornerShape(50)
                    Box(
                        Modifier
                            .offset(x = (-6 * 4 + 2).dp)
                            .defaultMinSize(minWidth = 26.dp)
                            .height(22.dp)
                            .background(colors.ink.copy(alpha = 0.09f), pill)
                            .then(
                                if (opensHidden.isEmpty()) {
                                    Modifier
                                } else {
                                    Modifier.clip(pill).clickable(role = Role.Button, onClickLabel = "Show the other ${opensHidden.size}") { isMenuOpen = true }
                                },
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        // The padding is the text's, so the menu below lines up with the pill's edge.
                        Text("+${wing.faces.size - 4}", Modifier.padding(horizontal = 7.dp), style = buildUiTextStyle(11.sp, BoldWeight, lineHeight = 1f), color = colors.ink)
                        if (isMenuOpen) {
                            HiddenColleaguesMenu(wing.name, opensHidden, onOpen, onDismiss = { isMenuOpen = false })
                        }
                    }
                }
            }
            val nameColor = lerp(colors.muted, colors.roomInlay2, 0.22f)
            Column {
                Text(wing.name, style = buildUiTextStyle(12.sp, BoldWeight, lineHeight = 1.3f), color = nameColor)
                Text(wing.note, style = buildUiTextStyle(12.sp, MediumWeight, lineHeight = 1.3f), color = nameColor)
            }
        }
    }
}

/**
 * Draws the menu "+N" opens: a row for each of the [rows] the wing named [wingName] has no
 * room to draw, which opens that colleague. The book's `.pop` popover, with its `.pop-h`
 * header and `.line` rows, drops 6 dp below "+N" and grows to the left, because the Lobby
 * sits in the right-hand column. A tap outside the menu, or Back, closes it.
 */
@Composable
private fun HiddenColleaguesMenu(wingName: String, rows: List<OfficeRow>, onOpen: (OfficeRow) -> Unit, onDismiss: () -> Unit) {
    val colors = bureauColors
    val shape = RoundedCornerShape(BureauScales.rLg)
    // A popup window clips what it draws to its own bounds, so the menu sits inside a margin
    // wide enough for its shadow, and the offset takes that margin back out.
    val shadowMargin = 24.dp
    val offset = with(LocalDensity.current) { IntOffset(shadowMargin.roundToPx(), (22.dp + 6.dp - shadowMargin).roundToPx()) }
    Popup(alignment = Alignment.TopEnd, offset = offset, onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
        Column(
            Modifier
                // The margin belongs to the popup window, so a tap on it is not outside the
                // popup and would not dismiss it. The menu dismisses it itself.
                .pointerInput(onDismiss) {
                    val margin = shadowMargin.toPx()
                    detectTapGestures { tap ->
                        val isOnPanel = tap.x in margin..size.width - margin && tap.y in margin..size.height - margin
                        if (!isOnPanel) onDismiss()
                    }
                }
                .padding(shadowMargin)
                .width(240.dp)
                .glassShadow(shape)
                // The book's glass fill is see-through, and blurs what is behind it. Android
                // cannot blur behind a popup cheaply, so the menu takes the opaque colours the
                // glass is made of, and the wing's text does not show through.
                .background(colors.raised, shape)
                .border(1.dp, colors.line, shape),
        ) {
            Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 12.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(wingName, Modifier.weight(1f), style = buildUiTextStyle(BureauScales.t13, BoldWeight), color = colors.ink)
                Text("${rows.size} more", style = buildUiTextStyle(BureauScales.t12), color = colors.muted)
            }
            Hairline()
            // A tall list scrolls. Its height shows part of a seventh row, which hints that more follow.
            Column(Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState()).padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 8.dp)) {
                for (row in rows) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(BureauScales.rMd))
                            .clickable(role = Role.Button, onClickLabel = "Open ${row.title}") {
                                onDismiss()
                                onOpen(row)
                            }
                            .padding(6.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ColleagueFace(row.face, 28.dp, badgeRing = colors.raised)
                        Text(
                            row.title,
                            style = buildUiTextStyle(BureauScales.t13, MediumWeight),
                            color = colors.ink,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

/** Draws a lane's head, the book's `.m-lane`: its title and count, and the oldest age for Waiting on you. */
@Composable
private fun OfficeLaneHead(lane: OfficeLane) {
    val waiting = lane.kind == OfficeLaneKind.Waiting
    LaneHead {
        LaneTitle(lane.kind.title)
        CountPill(lane.rows.size, waiting, Modifier.offset(x = (-2).dp))
        Spacer(Modifier.weight(1f))
        if (waiting && lane.oldestAge != null) {
            Text("oldest ${lane.oldestAge}", style = buildUiTextStyle(12.sp), color = bureauColors.faint)
        }
    }
}

/**
 * Draws the ask card, the book's `.ask`: the oldest waiting thread with its question and the two
 * answers one thumb away. Allow and Deny show only when [request] accepts them, and stop
 * taking taps once the Request is [answered].
 */
@Composable
private fun AskCard(
    row: OfficeRow,
    request: ApprovalRequest,
    runnerName: String?,
    projects: List<Project>,
    answered: Boolean,
    onOpen: (OfficeRow) -> Unit,
    onDecide: (OfficeRow, ApprovalDecision) -> Unit,
) {
    val colors = bureauColors
    val haptics = LocalHapticFeedback.current
    val shape = RoundedCornerShape(20.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .bureauShadow(BureauElevation.Lifted, shape)
            .background(colors.raised, shape)
            .border(1.dp, colors.lineSoft, shape)
            .padding(14.dp),
    ) {
        Row(
            Modifier.clickable(role = Role.Button, onClickLabel = "Open ${row.title}") { onOpen(row) },
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ColleagueFace(row.face, 40.dp, badgeRing = colors.raised)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(row.title, Modifier.weight(1f), style = buildUiTextStyle(15.sp, BoldWeight), color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    row.age?.let { Text(it, style = buildUiTextStyle(12.sp), color = colors.faint) }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    row.project?.let { ProjectLabel(it.name, pickProjectTint(it, projects, colors), colors.muted) }
                    runnerName?.let {
                        if (row.project != null) Text("·", style = buildUiTextStyle(12.sp), color = colors.faint)
                        Text(it, style = buildUiTextStyle(12.sp), color = colors.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        CodeText(
            buildDockTitle(request),
            buildUiTextStyle(15.sp, lineHeight = 1.45f).copy(color = colors.ink),
            InlineCodeStyle(13.sp, colors.ink),
            Modifier.padding(top = 10.dp),
        )
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (ApprovalDecision.Allow in request.decisions) {
                BureauButton(
                    "Allow",
                    onClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                        onDecide(row, ApprovalDecision.Allow)
                    },
                    modifier = Modifier.weight(1f),
                    look = ButtonLook.Accent,
                    size = ButtonSize.Large,
                    enabled = !answered,
                )
            }
            if (ApprovalDecision.Deny in request.decisions) {
                BureauButton(
                    "Deny",
                    onClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.Reject)
                        onDecide(row, ApprovalDecision.Deny)
                    },
                    modifier = Modifier.weight(1f),
                    look = ButtonLook.Quiet,
                    size = ButtonSize.Large,
                    enabled = !answered,
                )
            }
        }
    }
}

/**
 * Draws one colleague, the book's `.row`: the face, the title and its age, and the detail line,
 * whose state is in the waiting colour while the colleague waits on the user.
 */
@Composable
private fun OfficeRowLine(row: OfficeRow, projects: List<Project>, onOpen: (OfficeRow) -> Unit, modifier: Modifier = Modifier) {
    val colors = bureauColors
    ColleagueRow(
        row.face,
        row.title,
        onOpen = { onOpen(row) },
        end = { Text(row.age.orEmpty(), style = buildUiTextStyle(12.sp), color = colors.faint) },
        modifier = modifier,
    ) {
        // A waiting row gives its whole line to the question, as the book's waiting rows do.
        val waiting = row.pose == Pose.Waiting
        when {
            waiting -> Unit
            row.assistantId != null -> Text("Assistant · ", style = buildUiTextStyle(12.sp), color = colors.muted)
            row.project != null -> {
                ProjectLabel(row.project.name, pickProjectTint(row.project, projects, colors), colors.muted, weight = RegularWeight)
                Text(" · ", style = buildUiTextStyle(12.sp), color = colors.muted)
            }
        }
        Text(
            row.state,
            style = buildUiTextStyle(12.sp, if (waiting) MediumWeight else RegularWeight),
            color = if (waiting) colors.youInk else colors.muted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Returns the name of the runner whose field seats [row]'s face, or null when no field does. */
private fun findRunnerName(fields: List<OfficeField>, row: OfficeRow): String? =
    fields.firstOrNull { field -> field.faces.any { it.seed == row.face.seed } }?.runner?.name
