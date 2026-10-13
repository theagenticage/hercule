package dev.hercule.android.ui.thread

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.office.formatAge
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.theme.MediumWeight
import dev.hercule.android.ui.AgentByline
import dev.hercule.android.ui.BureauIcon
import dev.hercule.android.ui.BureauIcons
import dev.hercule.android.ui.CodeText
import dev.hercule.android.ui.ColleagueFace
import dev.hercule.android.ui.Composer
import dev.hercule.android.ui.Hairline
import dev.hercule.android.ui.InlineCodeStyle
import dev.hercule.android.ui.MessageBody
import dev.hercule.android.ui.NavBar
import dev.hercule.android.ui.TextRun
import dev.hercule.android.ui.UserBubble
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.buildUiTextStyle
import dev.hercule.android.ui.formatClockTime
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.QuestionAnswers
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.TurnState
import java.time.ZoneId
import kotlin.time.Instant

/**
 * What the Thread screen draws:
 *
 * - [title], [face] and [projectName] for the bar at the top, with the face's pose words;
 * - [blocks], the transcript from [buildThreadBlocks];
 * - [openRequest], the oldest open Request, docked above the composer, or null;
 * - [waitingCount], how many colleagues wait on the user, on the back button;
 * - [now] and [zone], to write ages and clock times.
 */
data class ThreadUiState(
    val title: String,
    val face: OfficeFace,
    val projectName: String?,
    val blocks: List<ThreadBlock>,
    val openRequest: SessionRequest?,
    val waitingCount: Int,
    val now: Instant,
    val zone: ZoneId,
)

/**
 * Draws a thread, the book's mobile/session-active.html: the bar with the thread's face and
 * title, the transcript scrolled to its newest block, the open Request docked above the
 * composer, and the composer.
 *
 * [onDecide] and [onAnswer] answer the docked Request; [onSend] sends the composer's text into
 * the thread; [onBack] leaves the screen.
 */
@Composable
fun ThreadScreen(
    state: ThreadUiState,
    onBack: () -> Unit,
    onDecide: (ApprovalDecision) -> Unit,
    onAnswer: (QuestionAnswers) -> Unit,
    onSend: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = bureauColors
    Column(
        modifier
            .fillMaxSize()
            .background(colors.bg)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .imePadding(),
    ) {
        NavBar(
            onBack = onBack,
            backLabel = "Back to the Office",
            backBadge = state.waitingCount.takeIf { it > 0 },
            head = { ThreadHead(state) },
        )
        Transcript(state, Modifier.weight(1f).fillMaxWidth().background(colors.surface))
        Column(Modifier.background(colors.surface).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))) {
            state.openRequest?.let { request ->
                RequestDock(
                    request,
                    state.face,
                    onDecide,
                    onAnswer,
                    Modifier.padding(horizontal = 8.dp).layout { measurable, constraints ->
                        // The book's `margin-bottom: -14px`: the composer covers the dock's last 14 dp.
                        val placeable = measurable.measure(constraints)
                        layout(placeable.width, placeable.height - 14.dp.roundToPx()) { placeable.place(0, 0) }
                    },
                )
            }
            Composer("Reply or steer…", onSend, Modifier.padding(start = 8.dp, end = 8.dp, bottom = 8.dp))
        }
    }
}

/** Draws the bar's head: the face at 30 dp, the title, and "<project> · <pose words>". */
@Composable
private fun ThreadHead(state: ThreadUiState) {
    val colors = bureauColors
    ColleagueFace(state.face, 30.dp)
    Column {
        Text(state.title, style = buildUiTextStyle(15.sp, BoldWeight, lineHeight = 1.2f), color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            buildAnnotatedString {
                state.projectName?.let { append("$it · ") }
                val waiting = state.openRequest != null
                withStyle(SpanStyle(color = if (waiting) colors.youInk else colors.muted)) { append(state.face.pose.words) }
            },
            style = buildUiTextStyle(11.sp, lineHeight = 1.3f),
            color = colors.muted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Draws the transcript, newest block at the bottom and scrolled there when the screen opens, as
 * a chat opens on its latest message. A work stretch's divider opens to list its items.
 */
@Composable
private fun Transcript(state: ThreadUiState, modifier: Modifier) {
    var opened by rememberSaveable { mutableStateOf(emptyList<String>()) }
    LazyColumn(
        modifier,
        reverseLayout = true,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        items(state.blocks.asReversed(), key = { it.key }) { block ->
            when (block) {
                is UserBlock -> UserBubble(block.text, formatClockTime(block.at, state.zone))
                is AgentBlock -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    // The book signs an agent's message with the thread's own name and face.
                    AgentByline(state.face.copy(pose = Pose.Idle), state.title, formatClockTime(block.startedAt, state.zone))
                    MessageBody(block.text)
                }
                is WorkBlock -> WorkDivider(
                    block,
                    state.now,
                    open = block.key in opened,
                    onToggle = { opened = if (block.key in opened) opened - block.key else opened + block.key },
                )
                is WaitingBlock -> StatusLine(
                    BureauIcons.WaitingMark,
                    "Waiting on you since ${formatClockTime(block.openedAt, state.zone)} · ${formatAge(block.openedAt, state.now)}",
                    bureauColors.youInk,
                )
                is WarningBlock -> StatusLine(BureauIcons.Alarm, block.message, bureauColors.muted)
                is EndingBlock -> StatusLine(
                    BureauIcons.Stop,
                    "${if (block.state == TurnState.Failed) "Failed" else "Stopped"} after ${formatDuration(block.duration)}",
                    if (block.state == TurnState.Failed) bureauColors.failInk else bureauColors.muted,
                )
            }
        }
    }
}

/**
 * Draws a work stretch's divider, the book's `.worked`: "Worked for 2m 14s ›", the stretch's
 * summary, and a hairline filling the rest of the line. A tap opens it to one row per item.
 */
@Composable
private fun WorkDivider(block: WorkBlock, now: Instant, open: Boolean, onToggle: () -> Unit) {
    val colors = bureauColors
    val duration = formatDuration((block.endedAt ?: now) - block.startedAt)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = if (open) "Hide the steps" else "Show the steps", onClick = onToggle),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    if (block.endedAt == null) "Working for $duration" else "Worked for $duration",
                    style = buildUiTextStyle(12.sp, MediumWeight),
                    color = colors.muted,
                )
                BureauIcon(if (open) BureauIcons.ChevronDown else BureauIcons.ChevronRight, colors.muted, size = 12.dp)
            }
            Text(summarizeWork(block.items).joinToString(", "), style = buildUiTextStyle(12.sp), color = colors.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Hairline(Modifier.weight(1f))
        }
        if (open) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { block.items.forEach { WorkItemRow(it) } }
        }
    }
}

/**
 * Draws one item of an opened work stretch: an icon for its kind, its verb, and its target, as
 * code for a command or a path. A kind this build does not know gets the generic "Step" row.
 */
@Composable
private fun WorkItemRow(item: WorkItem) {
    val colors = bureauColors
    val (icon, verb) = when (item.kind) {
        ItemKind.CommandExecution -> BureauIcons.Terminal to "Ran"
        ItemKind.FileChange -> BureauIcons.Diff to "Edited"
        ItemKind.FileRead -> BureauIcons.File to "Read"
        ItemKind.FileSearch -> BureauIcons.File to "Searched"
        ItemKind.WebSearch -> BureauIcons.Question to "Searched the web"
        ItemKind.ToolCall -> BureauIcons.Terminal to "Used"
        ItemKind.Subagent -> BureauIcons.User to "Ran a subagent"
        ItemKind.Plan -> BureauIcons.Check to "Planned"
        ItemKind.ContextCompaction -> BureauIcons.Memory to "Compacted the context"
        ItemKind.Error -> BureauIcons.Close to "Error"
        else -> BureauIcons.Question to "Step"
    }
    val failed = item.status == ItemStatus.Failed || item.status == ItemStatus.Declined
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 2.dp)) { BureauIcon(icon, if (failed) colors.failInk else colors.faint, size = 14.dp) }
        val runs = buildList {
            add(TextRun(if (item.target.isEmpty()) verb else "$verb ", false))
            if (item.target.isNotEmpty()) add(TextRun(item.target, item.targetIsCode))
            if (item.status == ItemStatus.Failed) add(TextRun(" · failed", false))
            if (item.status == ItemStatus.Declined) add(TextRun(" · declined", false))
        }
        CodeText(
            runs,
            buildUiTextStyle(12.sp, lineHeight = 1.4f).copy(color = if (failed) colors.failInk else colors.muted),
            InlineCodeStyle(11.5.sp, colors.ink),
            Modifier.weight(1f),
            maxLines = 2,
        )
    }
}

/** Draws a one-line status in the transcript: [icon] and [text], both in [color]. */
@Composable
private fun StatusLine(icon: ImageVector, text: String, color: Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        BureauIcon(icon, color, size = 16.dp)
        Text(text, style = buildUiTextStyle(12.sp, MediumWeight), color = color)
    }
}
