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
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
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
import dev.hercule.android.ui.NavBar
import dev.hercule.android.ui.TextRun
import dev.hercule.android.ui.UserBubble
import dev.hercule.android.ui.buildUiTextStyle
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.formatClockTime
import dev.hercule.android.ui.rememberListStateFollowingNewest
import dev.hercule.android.ui.markdown.MessageAuthor
import dev.hercule.android.ui.markdown.MessageMarkdown
import dev.hercule.android.ui.withoutReportedWidth
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.QuestionAnswers
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.TurnState
import java.time.ZoneId
import kotlin.math.roundToInt
import kotlin.time.Instant

/**
 * What the Thread screen draws:
 *
 * - [title], [face] and [projectName] for the bar at the top, with the face's pose words;
 * - [blocks], the transcript from [buildThreadBlocks];
 * - [openRequest], the oldest open Request, docked above the composer, or null, and whether
 *   it is [openRequestAnswered] from this screen, with the answer not failed;
 * - [waitingCount], how many threads wait on the user, on the back button;
 * - [resumeBlockedReason], why the thread cannot take input, or null when it can;
 * - [now] and [zone], to write ages and clock times.
 */
data class ThreadUiState(
    val title: String,
    val face: OfficeFace,
    val projectName: String?,
    val blocks: List<ThreadBlock>,
    val openRequest: SessionRequest?,
    val openRequestAnswered: Boolean,
    val waitingCount: Int,
    val resumeBlockedReason: String?,
    val now: Instant,
    val zone: ZoneId,
)

/**
 * Draws a thread, the book's mobile/session-active.html: the bar with the thread's face and
 * title, the transcript scrolled to its newest block, the open Request docked above the
 * composer, and the composer.
 *
 * [onDecide] and [onAnswer] answer the docked Request; [onSend] sends the composer's text into
 * the thread, and calls its second argument when the text was not sent; [onBack] leaves the
 * screen, and [backLabel] names the back button for a screen reader by the screen it returns to,
 * such as "Back to the Office".
 *
 * A thread that cannot be resumed draws its composer disabled, with the reason as its
 * placeholder, because anything sent to it would fail.
 */
@Composable
fun ThreadScreen(
    state: ThreadUiState,
    onBack: () -> Unit,
    backLabel: String,
    onDecide: (requestId: String, ApprovalDecision) -> Unit,
    onAnswer: (requestId: String, QuestionAnswers) -> Unit,
    onSend: (text: String, onFailure: () -> Unit) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = bureauColors
    Column(
        modifier
            .fillMaxSize()
            .background(colors.bg)
            // Only the top inset pads the whole screen. Each part takes the side insets inside
            // its own background, so in landscape the backgrounds reach the screen's edges while
            // the bar, the messages and the composer all keep clear of the cutout alike.
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top))
            .imePadding(),
    ) {
        NavBar(
            modifier = Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
            onBack = onBack,
            backLabel = backLabel,
            backBadge = state.waitingCount.takeIf { it > 0 },
            head = { ThreadHead(state) },
        )
        Transcript(state, Modifier.weight(1f).fillMaxWidth().background(colors.surface).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)))
        Column(Modifier.background(colors.surface).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))) {
            state.openRequest?.let { request ->
                RequestDock(
                    request,
                    state.face,
                    state.openRequestAnswered,
                    onDecide,
                    onAnswer,
                    Modifier.padding(horizontal = 8.dp).dockUnderComposer(),
                )
            }
            val reason = state.resumeBlockedReason
            Composer(
                if (reason == null) "Reply or steer…" else "This thread can't be resumed: $reason.",
                onSend,
                Modifier.padding(start = 8.dp, end = 8.dp, bottom = 8.dp),
                enabled = reason == null,
            )
        }
    }
}

/**
 * Lays the dock out under the composer. The dock takes at most [DOCK_HEIGHT_SHARE] of the height
 * below the bar, so a tall Request never pushes the composer off screen; the dock scrolls
 * instead. The composer then covers the dock's last 14 dp, as the book's `margin-bottom: -14px`.
 */
fun Modifier.dockUnderComposer(): Modifier = layout { measurable, constraints ->
    val maxHeight = if (constraints.hasBoundedHeight) (constraints.maxHeight * DOCK_HEIGHT_SHARE).roundToInt() else constraints.maxHeight
    val placeable = measurable.measure(constraints.copy(maxHeight = maxOf(constraints.minHeight, maxHeight)))
    layout(placeable.width, placeable.height - 14.dp.roundToPx()) { placeable.place(0, 0) }
}

/** The share of the height below the bar that the docked Request may take. */
private const val DOCK_HEIGHT_SHARE = 0.6f

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
            Modifier.withoutReportedWidth(),
            style = buildUiTextStyle(11.sp, lineHeight = 1.3f),
            color = colors.muted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Draws the transcript, newest block at the bottom and scrolled there when the screen opens, as
 * a chat opens on its latest message. A new block scrolls into view while the user is at the
 * newest one, and always when the user sent it. A work stretch's divider opens to list its items.
 */
@Composable
private fun Transcript(state: ThreadUiState, modifier: Modifier) {
    var opened by rememberSaveable { mutableStateOf(emptyList<String>()) }
    val newestBlock = state.blocks.lastOrNull()
    LazyColumn(
        modifier,
        rememberListStateFollowingNewest(newestBlock?.key, addedByUser = newestBlock is UserBlock),
        reverseLayout = true,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        // A row is reused only for a block of its own kind, whose composition has the same shape.
        items(state.blocks.asReversed(), key = { it.key }, contentType = { it::class }) { block ->
            // Each row gets only the values it draws, so a streamed token redraws the one block
            // that changed, and the minute tick redraws only the rows that show an age.
            val usesNow = block is WorkBlock || block is WaitingBlock
            // Each row draws on a layer of its own, so scrolling moves the layers and a row that
            // changed records its drawing again without the rows around it.
            Box(Modifier.graphicsLayer()) {
                TranscriptRow(
                    block,
                    state.face,
                    state.title,
                    state.zone,
                    now = if (usesNow) state.now else null,
                    open = block.key in opened,
                    onToggle = { opened = if (block.key in opened) opened - block.key else opened + block.key },
                )
            }
        }
    }
}

/**
 * Draws one block of the transcript. An agent's message is signed with the thread's [face] and
 * [title], as the book signs it; times are written in [zone]. [now] is given only to the blocks
 * that show an age or a running duration. [open] and [onToggle] belong to a work stretch's divider.
 */
@Composable
private fun TranscriptRow(
    block: ThreadBlock,
    face: OfficeFace,
    title: String,
    zone: ZoneId,
    now: Instant?,
    open: Boolean,
    onToggle: () -> Unit,
) {
    when (block) {
        is UserBlock -> UserBubble(
            block.text,
            formatClockTime(block.at, zone),
            if (block.senderSessionId == null) MessageAuthor.User else MessageAuthor.AnotherAgent,
        )
        // Until its first word arrives, an open message is the "Writing…" line, so the thread
        // never shows a byline beside no text.
        is AgentBlock -> if (block.text.isEmpty()) {
            WritingLine()
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                AgentByline(face.copy(pose = Pose.Idle), title, formatClockTime(block.startedAt, zone))
                MessageMarkdown(block.text, MessageAuthor.Agent, writing = block.open)
            }
        }
        is WorkBlock -> WorkDivider(block, checkNotNull(now), open, onToggle)
        is WaitingBlock -> StatusLine(
            BureauIcons.WaitingMark,
            "Waiting on you since ${formatClockTime(block.openedAt, zone)} · ${formatAge(block.openedAt, checkNotNull(now))}",
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

/**
 * Draws the line that stands for an agent message whose first word has not arrived, the
 * desktop's pending note in the book's `.worked` drawing: "Writing…" in muted medium text, and a
 * hairline filling the rest of the line. A screen reader hears "Writing" once, as a status.
 */
@Composable
private fun WritingLine() {
    val colors = bureauColors
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            "Writing…",
            Modifier.semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = "Writing"
            },
            style = buildUiTextStyle(12.sp, MediumWeight),
            color = colors.muted,
        )
        Hairline(Modifier.weight(1f))
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
