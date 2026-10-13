package dev.hercule.android.ui.assistant

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.ui.AgentByline
import dev.hercule.android.ui.BureauButton
import dev.hercule.android.ui.BureauIcon
import dev.hercule.android.ui.BureauIcons
import dev.hercule.android.ui.ButtonLook
import dev.hercule.android.ui.ButtonSize
import dev.hercule.android.ui.ColleagueFace
import dev.hercule.android.ui.Composer
import dev.hercule.android.ui.IconButton
import dev.hercule.android.ui.MessageBody
import dev.hercule.android.ui.NavBar
import dev.hercule.android.ui.UserBubble
import dev.hercule.android.ui.buildUiTextStyle
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.formatClockTime
import dev.hercule.android.ui.pickCrewColors
import dev.hercule.android.ui.rememberListStateFollowingNewest
import dev.hercule.android.ui.thread.RequestDock
import dev.hercule.android.ui.thread.dockUnderComposer
import dev.hercule.android.ui.withoutReportedWidth
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.ConversationSenderRole
import dev.hercule.android.wire.QuestionAnswers
import dev.hercule.android.wire.SessionRequest
import java.time.ZoneId

/**
 * A reminder the assistant set, drawn as a card under the message [afterMessageId]: [title] and
 * [detail], such as "Fri 2 Oct · 09:00 · to Web chat". The wire has no reminders yet, so only a
 * fixture fills this; editing one is not part of the app, and its Edit button is drawn disabled.
 */
data class ReminderCard(val afterMessageId: String, val title: String, val detail: String)

/**
 * What the Assistant screen draws:
 *
 * - the assistant's [name] and [face];
 * - whether it is [answering], and the [answerSoFar]: the text of its reply that no stored
 *   message holds yet, or null;
 * - the [messages] of its main Conversation in position order;
 * - the id of its current session ([sessionId]), that session's oldest open Request
 *   ([openRequest]) or null, and whether that Request is [openRequestAnswered] from this screen;
 * - an optional [reminder];
 * - the [zone] message times are written in.
 */
data class AssistantUiState(
    val name: String,
    val face: OfficeFace,
    val answering: Boolean,
    val answerSoFar: String?,
    val messages: List<ConversationMessage>,
    val sessionId: String?,
    val openRequest: SessionRequest?,
    val openRequestAnswered: Boolean,
    val reminder: ReminderCard?,
    val zone: ZoneId,
)

/**
 * Draws an assistant's main Conversation, the book's mobile/assistant.html: the bar with its
 * face and state, the messages scrolled to the newest and following new ones, and the composer.
 *
 * [onSend] sends a message to the assistant, and calls its second argument when the message was
 * not sent; [onBack] leaves for the crew. [speechInput] draws the hold-to-talk mic in the empty
 * composer, whose recognised words are sent as a message; null hides the mic, on a device with
 * no on-device recognition. Memory is not part of the app yet, so its button is drawn disabled.
 *
 * An open Request of the assistant's session is docked above the composer, as on the Thread
 * screen, and [onDecide] and [onAnswer] answer it.
 */
@Composable
fun AssistantScreen(
    state: AssistantUiState,
    onBack: () -> Unit,
    onSend: (text: String, onFailure: () -> Unit) -> Unit,
    onDecide: (requestId: String, ApprovalDecision) -> Unit,
    onAnswer: (requestId: String, QuestionAnswers) -> Unit,
    speechInput: SpeechInput?,
    modifier: Modifier = Modifier,
) {
    val colors = bureauColors
    val whoInk = pickCrewColors(state.face).whoInk
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
            backLabel = "Back to the crew",
            backText = "Crew",
            head = {
                ColleagueFace(state.face, 30.dp)
                Column(Modifier.semantics(mergeDescendants = true) {}) {
                    Text(state.name, style = buildUiTextStyle(15.sp, BoldWeight, lineHeight = 1.2f), color = colors.ink)
                    Text(
                        if (state.answering) "answering…" else state.face.pose.words,
                        Modifier.withoutReportedWidth(),
                        style = buildUiTextStyle(11.sp, lineHeight = 1.3f),
                        color = whoInk,
                        maxLines = 1,
                        softWrap = false,
                    )
                }
            },
            trailing = { IconButton(BureauIcons.Memory, "${state.name}'s Memory", onClick = {}, enabled = false) },
        )
        val newestMessage = state.messages.lastOrNull()
        val showsAnswer = state.answering || state.answerSoFar != null
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth().background(colors.surface).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
            rememberListStateFollowingNewest(
                newestKey = if (showsAnswer) ANSWER_KEY else newestMessage?.id,
                addedByUser = !showsAnswer && newestMessage?.senderRole == ConversationSenderRole.Owner,
            ),
            reverseLayout = true,
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            // A finished answer stays drawn after the assistant stops working, until it is stored.
            if (showsAnswer) {
                item(key = ANSWER_KEY) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        AgentByline(state.face, state.name, if (state.answering) "answering…" else state.face.pose.words)
                        state.answerSoFar?.let { MessageBody(it, caret = whoInk) }
                    }
                }
            }
            items(state.messages.asReversed(), key = { it.id }) { message ->
                // Each row gets only the values it draws, so a streamed token redraws no stored message.
                ConversationRow(message, state.face, state.zone, state.reminder?.takeIf { it.afterMessageId == message.id })
            }
        }
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
            Composer(
                "Message ${state.name}…",
                onSend,
                Modifier.padding(start = 8.dp, end = 8.dp, bottom = 8.dp),
                idleButton = speechInput?.let { input -> { HoldToTalkButton(state.name, input) { text -> onSend(text) {} } } },
            )
        }
    }
}

/**
 * Draws one message of the Conversation: the user's bubble, the assistant's message signed with
 * [face], or a notice. Times are written in [zone]; [reminder] is drawn under the message.
 */
@Composable
private fun ConversationRow(message: ConversationMessage, face: OfficeFace, zone: ZoneId, reminder: ReminderCard?) {
    val time = formatClockTime(message.createdAt, zone)
    when (message.senderRole) {
        ConversationSenderRole.Owner -> UserBubble(message.text, time)
        ConversationSenderRole.Notice -> Notice(message.text, time, face)
        else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            AgentByline(face.copy(pose = Pose.Idle), message.senderLabel, time)
            MessageBody(message.text)
            reminder?.let { Reminder(it, face) }
        }
    }
}

/** Draws a notice the system wrote, the book's `.notice`: the failed face, the text and the time. */
@Composable
private fun Notice(text: String, time: String, face: OfficeFace) {
    val colors = bureauColors
    Row(
        Modifier
            .fillMaxWidth()
            .background(colors.failTint, RoundedCornerShape(16.dp))
            .padding(start = 8.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ColleagueFace(face.copy(pose = Pose.Failed), 28.dp, badgeRing = colors.failTint)
        Text("$text  $time", Modifier.weight(1f), style = buildUiTextStyle(12.sp, lineHeight = 1.4f), color = colors.failInk)
    }
}

/** Draws a reminder card, the book's `.reminder`, on the assistant's tint, with its Edit disabled. */
@Composable
private fun Reminder(reminder: ReminderCard, face: OfficeFace) {
    val colors = bureauColors
    val crew = pickCrewColors(face)
    Row(
        Modifier
            .padding(top = 4.dp)
            .fillMaxWidth()
            .background(crew.whoTint, RoundedCornerShape(16.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BureauIcon(BureauIcons.Alarm, crew.whoInk, size = 20.dp)
        Column(Modifier.weight(1f)) {
            Text(reminder.title, style = buildUiTextStyle(14.sp, BoldWeight, lineHeight = 1.4f), color = colors.ink)
            Text(reminder.detail, style = buildUiTextStyle(12.sp), color = colors.muted)
        }
        BureauButton("Edit", onClick = {}, look = ButtonLook.Quiet, size = ButtonSize.Small, enabled = false)
    }
}

/**
 * Draws the hold-to-talk mic, the book's `.m-mic`: pressing starts [input], letting go stops it,
 * and the recognised words are sent through [onSend]. The mic turns marigold while it listens.
 *
 * TalkBack cannot hold a button, so with TalkBack a double tap starts listening and a second
 * double tap stops it. Listening also stops when the mic leaves the screen, and a result that
 * arrives after that is dropped.
 *
 * Drawn 44 dp wide, the mic still has a 48 dp touch area, because Compose extends it; see [BureauButton].
 */
@Composable
private fun HoldToTalkButton(name: String, input: SpeechInput, onSend: (String) -> Unit) {
    val colors = bureauColors
    var listening by remember { mutableStateOf(false) }
    var onScreen by remember { mutableStateOf(true) }
    val onResult: (String?) -> Unit = { text ->
        listening = false
        if (text != null && onScreen) onSend(text)
    }
    DisposableEffect(input) {
        onDispose {
            onScreen = false
            input.stop()
        }
    }
    Box(
        Modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(if (listening) colors.you else colors.btnFill)
            .border(1.dp, colors.btnRim, CircleShape)
            .semantics {
                role = Role.Button
                contentDescription = "Hold to talk to $name"
                onClick(if (listening) "Stop listening" else "Start listening") {
                    if (listening) {
                        listening = false
                        input.stop()
                    } else {
                        // Set first, because start may call onResult straight away.
                        listening = true
                        input.start(onResult)
                    }
                    true
                }
            }
            .pointerInput(input) {
                detectTapGestures(
                    onPress = {
                        listening = true
                        input.start(onResult)
                        try {
                            tryAwaitRelease()
                        } finally {
                            // Also when the press is cancelled, such as when the screen closes mid-press.
                            input.stop()
                            listening = false
                        }
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        BureauIcon(BureauIcons.Mic, if (listening) colors.faceInk else colors.ink, size = 20.dp)
    }
}

/** The list key of the assistant's answer while it is written, which no stored message id can equal. */
private const val ANSWER_KEY = "answering"
