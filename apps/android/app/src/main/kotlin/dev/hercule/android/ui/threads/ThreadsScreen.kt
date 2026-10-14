package dev.hercule.android.ui.threads

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.hercule.android.faces.Accessory
import dev.hercule.android.faces.BodyShape
import dev.hercule.android.faces.Face
import dev.hercule.android.faces.Hue
import dev.hercule.android.faces.Look
import dev.hercule.android.faces.Pose
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.theme.MediumWeight
import dev.hercule.android.theme.RegularWeight
import dev.hercule.android.threads.DONE_SHELF_STEP
import dev.hercule.android.threads.ThreadList
import dev.hercule.android.threads.ThreadRow
import dev.hercule.android.threads.ThreadRowStatus
import dev.hercule.android.ui.BureauIcon
import dev.hercule.android.ui.BureauIcons
import dev.hercule.android.ui.ColleagueRow
import dev.hercule.android.ui.CountPill
import dev.hercule.android.ui.LaneHead
import dev.hercule.android.ui.LaneTitle
import dev.hercule.android.ui.ProjectLabel
import dev.hercule.android.ui.Tab
import dev.hercule.android.ui.TabBar
import dev.hercule.android.ui.buildUiTextStyle
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.drawTopHairline
import dev.hercule.android.ui.pickProjectTint
import dev.hercule.android.wire.Project

/**
 * What the Threads screen draws: the [list] from `buildThreadList`, the [projects] that tint each
 * project's swatch, and whether the Done shelf is [doneOpen].
 */
data class ThreadsUiState(val list: ThreadList, val projects: List<Project>, val doneOpen: Boolean)

/**
 * Draws the Threads screen, the book's mobile/threads.html: the title, then Waiting on you, a
 * section per project and the Done shelf in one list, and the tab bar. With no thread at all it
 * draws the empty state in place of the list.
 *
 * [onOpen] opens a row's thread by its session id. [onToggleDone] opens or closes the Done shelf, and [onShowMoreDone]
 * shows more of it. [onSelectTab] switches tabs.
 */
@Composable
fun ThreadsScreen(
    state: ThreadsUiState,
    onOpen: (sessionId: String) -> Unit,
    onToggleDone: () -> Unit,
    onShowMoreDone: () -> Unit,
    onSelectTab: (Tab) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = bureauColors
    val list = state.list
    Column(modifier.fillMaxSize().background(colors.bg)) {
        Text(
            "Threads",
            Modifier
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 10.dp),
            style = buildUiTextStyle(28.sp, BoldWeight, letterSpacing = (-0.02).em),
            color = colors.ink,
        )
        if (list.isEmpty()) {
            EmptyThreads(Modifier.weight(1f))
        } else {
            LazyColumn(
                // In landscape the rows keep clear of the camera cutout and the side navigation
                // bar, as the title above them does.
                Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 20.dp),
            ) {
                if (list.waiting.isNotEmpty()) {
                    item(key = "waiting", contentType = "head") {
                        LaneHead {
                            LaneTitle("Waiting on you")
                            CountPill(list.waiting.size, waiting = true, Modifier.offset(x = (-2).dp))
                        }
                    }
                    addThreadRows("waiting", list.waiting) { row, line ->
                        ThreadRowLine(row, onOpen, line) { Detail(row) }
                    }
                }
                list.projects.forEach { section ->
                    val sectionKey = "project-${section.project?.id}"
                    item(key = sectionKey, contentType = "head") { ProjectHead(section.project, section.waitingCount, state.projects) }
                    addThreadRows(sectionKey, section.rows) { row, line ->
                        ThreadRowLine(row, onOpen, line) { Detail(row) }
                    }
                }
                if (list.doneCount > 0) {
                    item(key = "done", contentType = "head") { DoneHead(list.doneCount, state.doneOpen, onToggleDone) }
                    addThreadRows("done", list.doneRows) { row, line ->
                        // The book dims the whole row, the line above it included.
                        ThreadRowLine(row, onOpen, Modifier.alpha(0.6f).then(line)) {
                            val project = row.project
                            ProjectLabel(project?.name ?: "No project", project?.let { pickProjectTint(it, state.projects, colors) }, colors.muted)
                        }
                    }
                    if (list.hiddenDoneCount > 0) {
                        item(key = "done-more", contentType = "more") { ShowMoreRow(minOf(list.hiddenDoneCount, DONE_SHELF_STEP), onShowMoreDone) }
                    }
                }
            }
        }
        TabBar(Tab.Threads, list.waiting.size, onSelectTab)
    }
}

/**
 * Adds [rows] to the list. [content] draws each row with the modifier it is given, which draws
 * the hairline above every row but the first, the book's `.row + .row`. A thread waiting on the
 * user is listed twice, so each key starts with its section's [sectionKey].
 */
private fun LazyListScope.addThreadRows(sectionKey: String, rows: List<ThreadRow>, content: @Composable (ThreadRow, Modifier) -> Unit) {
    itemsIndexed(rows, key = { _, row -> "$sectionKey-${row.sessionId}" }, contentType = { _, _ -> "row" }) { index, row ->
        content(row, if (index > 0) Modifier.drawTopHairline(bureauColors.lineSoft) else Modifier)
    }
}

/**
 * Draws a project's head: its swatch and name, and how many of its threads wait on the user when
 * any does. A null [project] is the threads in no project.
 */
@Composable
private fun ProjectHead(project: Project?, waitingCount: Int, projects: List<Project>) {
    val colors = bureauColors
    LaneHead {
        ProjectLabel(
            project?.name ?: "No project",
            project?.let { pickProjectTint(it, projects, colors) },
            colors.muted,
            Modifier.weight(1f),
            weight = BoldWeight,
        )
        if (waitingCount > 0) {
            Text(
                if (waitingCount == 1) "1 needs you" else "$waitingCount need you",
                style = buildUiTextStyle(12.sp, MediumWeight).copy(fontFeatureSettings = TABULAR_FIGURES),
                color = colors.youInk,
            )
        }
    }
}

/** Draws the Done shelf's head, the book's `.done-h`: "Done", the count, and a chevron that turns up while [open]. */
@Composable
private fun DoneHead(count: Int, open: Boolean, onToggle: () -> Unit) {
    val colors = bureauColors
    // The book's head is 44 dp tall; 48 dp keeps the touch area Android asks for.
    LaneHead(
        Modifier
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClickLabel = if (open) "Hide Done threads" else "Show Done threads", onClick = onToggle),
    ) {
        LaneTitle("Done")
        CountPill(count, waiting = false, Modifier.offset(x = (-2).dp))
        Spacer(Modifier.weight(1f))
        BureauIcon(BureauIcons.ChevronDown, colors.muted, Modifier.rotate(if (open) 180f else 0f))
    }
}

/** Draws the Done shelf's last row, the book's `.more-row`, which shows [count] more Done threads. */
@Composable
private fun ShowMoreRow(count: Int, onShowMore: () -> Unit) {
    val colors = bureauColors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 54.dp)
            .drawTopHairline(colors.lineSoft)
            .clickable(role = Role.Button, onClick = onShowMore)
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Show $count more", Modifier.weight(1f), style = buildUiTextStyle(13.sp, MediumWeight), color = colors.ink)
        BureauIcon(BureauIcons.ChevronDown, colors.muted)
    }
}

/** Draws one thread's row, with [row]'s status at the right end of its title and [detail] under it. */
@Composable
private fun ThreadRowLine(row: ThreadRow, onOpen: (sessionId: String) -> Unit, modifier: Modifier = Modifier, detail: @Composable () -> Unit) {
    ColleagueRow(row.face, row.title, onOpen = { onOpen(row.sessionId) }, end = { Status(row) }, detail = { detail() }, modifier = modifier)
}

/**
 * Draws a row's status slot: its age, the waiting or the working mark, or the word "queued" or
 * "offline", in the book's `.when`.
 */
@Composable
private fun Status(row: ThreadRow) {
    val colors = bureauColors
    when (row.status) {
        ThreadRowStatus.Waiting -> BureauIcon(BureauIcons.WaitingMark, colors.you)
        ThreadRowStatus.Working -> BureauIcon(BureauIcons.WorkingMark, colors.muted)
        ThreadRowStatus.Queued -> StatusWord("queued")
        ThreadRowStatus.Offline -> StatusWord("offline")
        ThreadRowStatus.Age -> StatusWord(row.age)
    }
}

/** Draws a word or an age in the status slot: small and faint. */
@Composable
private fun StatusWord(text: String) {
    Text(text, style = buildUiTextStyle(12.sp).copy(fontFeatureSettings = TABULAR_FIGURES), color = bureauColors.faint)
}

/** The OpenType feature for figures of one width, the book's `font-variant-numeric: tabular-nums`, so ages and counts line up. */
private const val TABULAR_FIGURES = "tnum"

/** Draws a row's second line: the question in the waiting colour while the thread waits, the pose's words otherwise. */
@Composable
private fun Detail(row: ThreadRow) {
    val colors = bureauColors
    val waiting = row.face.pose == Pose.Waiting
    Text(
        row.detail,
        style = buildUiTextStyle(12.sp, if (waiting) MediumWeight else RegularWeight),
        color = if (waiting) colors.youInk else colors.muted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** The book's look for the assistant every new install starts with, named Hercule: crew.js `CAST.Hercule`. */
private val FirstAssistantLook = Look(Hue.Sky, BodyShape.Round, listOf(Accessory.Tache, Accessory.Homburg), headwear = null)

/**
 * Draws the empty state, the book's `.empty`: Hercule asleep, and one calm line where the list
 * would be. It scrolls, because in landscape the book's top space leaves no room for the line.
 */
@Composable
private fun EmptyThreads(modifier: Modifier) {
    val colors = bureauColors
    Column(
        modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 40.dp, end = 40.dp, top = 188.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Face(FirstAssistantLook, Pose.Asleep, 56.dp, colors, Modifier.padding(bottom = 10.dp), badgeRing = colors.bg)
        Text("No threads yet", style = buildUiTextStyle(17.sp, BoldWeight), color = colors.ink)
        Text(
            "A thread you start on your Mac or from Intake shows here, under its project.",
            Modifier.widthIn(max = 270.dp),
            style = buildUiTextStyle(13.sp, lineHeight = 1.45f),
            color = colors.muted,
            textAlign = TextAlign.Center,
        )
    }
}
