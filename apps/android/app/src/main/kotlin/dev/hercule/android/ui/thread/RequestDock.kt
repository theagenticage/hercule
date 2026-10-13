package dev.hercule.android.ui.thread

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.theme.MediumWeight
import dev.hercule.android.ui.BureauButton
import dev.hercule.android.ui.BureauElevation
import dev.hercule.android.ui.BureauIcon
import dev.hercule.android.ui.BureauIcons
import dev.hercule.android.ui.BureauTextField
import dev.hercule.android.ui.ButtonLook
import dev.hercule.android.ui.ButtonSize
import dev.hercule.android.ui.CodeText
import dev.hercule.android.ui.ColleagueFace
import dev.hercule.android.ui.InlineCodeStyle
import dev.hercule.android.ui.TextRun
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.bureauShadow
import dev.hercule.android.ui.buildUiTextStyle
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.ApprovalRequest
import dev.hercule.android.wire.CommandApproval
import dev.hercule.android.wire.FileChangeApproval
import dev.hercule.android.wire.FileReadApproval
import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionAnswers
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.ToolApproval
import dev.hercule.android.wire.UnknownRequest

/**
 * Draws the docked Request, the book's `.dock`: the open [request] the thread waits on, asked by
 * [face], with its answers below it.
 *
 * - An approval offers one row per decision it accepts, in its order. Allow is the accent
 *   row; a tap calls [onDecide] with the Request's id and the decision.
 * - A question Request shows each question with its options and a field for the user's own
 *   answer, masked when the agent asked to keep the answer secret. Send answers calls [onAnswer]
 *   with the Request's id once every question has an answer.
 * - Once the Request is [answered], its answers stop taking taps. A failed answer makes it
 *   unanswered again, and the question draft is still there to send again.
 * - A Request of a kind this build does not know is shown with no answers, and a line saying
 *   where it can be answered.
 *
 * The callbacks get the id of the Request the dock draws, so a tap answers that Request even
 * when a newer one has replaced it in the screen's state before the dock is drawn again.
 *
 * The dock's bottom edge runs under the composer, as the book's `margin-bottom: -14px` lets it;
 * the screen draws the composer over it. A dock taller than the room the screen gives it scrolls.
 */
@Composable
fun RequestDock(
    request: SessionRequest,
    face: OfficeFace,
    answered: Boolean,
    onDecide: (requestId: String, ApprovalDecision) -> Unit,
    onAnswer: (requestId: String, QuestionAnswers) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = bureauColors
    val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    Column(
        modifier
            .fillMaxWidth()
            .background(colors.youTint.copy(alpha = 0.928f), shape)
            .border(1.dp, colors.you.copy(alpha = 0.45f), shape)
            .verticalScroll(rememberScrollState())
            .padding(start = 10.dp, end = 10.dp, top = 12.dp, bottom = 24.dp),
    ) {
        Row(
            Modifier.padding(horizontal = 4.dp).padding(bottom = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ColleagueFace(face, 30.dp, badgeRing = colors.youTint)
            CodeText(
                buildDockTitle(request),
                buildUiTextStyle(15.sp, MediumWeight, lineHeight = 1.35f).copy(color = colors.ink),
                InlineCodeStyle(12.sp, colors.ink, colors.raised, padding = 5.dp, radius = 5.dp),
                Modifier.weight(1f),
            )
        }
        when (request) {
            is ApprovalRequest -> ApprovalAnswers(request, answered) { onDecide(request.requestId, it) }
            is QuestionRequest -> QuestionAnswersForm(request, answered) { onAnswer(request.requestId, it) }
            is UnknownRequest -> Text(
                "This build of the app can't answer a Request of kind \"${request.kind ?: "unknown"}\". " +
                    "Answer it on the desktop or in the web app.",
                Modifier.padding(horizontal = 4.dp),
                style = buildUiTextStyle(13.sp),
                color = colors.muted,
            )
        }
    }
}

/**
 * Builds the dock's title for [request], with the command, the file or the tool as code:
 * "Run `git push`?", "Change `src/a.ts`?", "Change these files?" followed by the paths. A
 * question Request reads "The agent needs answers.", as the desktop's card does.
 */
fun buildDockTitle(request: SessionRequest): List<TextRun> {
    fun buildAskingRuns(verb: String, code: String) = listOf(TextRun("$verb ", false), TextRun(code, true), TextRun("?", false))
    fun buildFilesRuns(verb: String, paths: List<String>) = when (paths.size) {
        0 -> listOf(TextRun("$verb files?", false))
        1 -> buildAskingRuns(verb, paths.single())
        else -> listOf(TextRun("$verb these files? ", false)) + paths.flatMap { listOf(TextRun(it, true), TextRun(" ", false)) }.dropLast(1)
    }
    return when (request) {
        is CommandApproval ->
            if (request.detail.command.isBlank()) listOf(TextRun("Run this command?", false)) else buildAskingRuns("Run", request.detail.command)
        is FileChangeApproval -> buildFilesRuns("Change", request.detail.paths)
        is FileReadApproval -> buildFilesRuns("Read", request.detail.paths)
        is ToolApproval -> buildAskingRuns("Run", request.detail.toolName)
        is QuestionRequest -> listOf(TextRun("The agent needs answers.", false))
        is UnknownRequest -> listOf(TextRun("Answer this request?", false))
    }
}

/**
 * Returns the label of an approval's [decision]: "Allow", "Allow always", "Deny" or
 * "Cancel", or the decision's wire value for one this build does not know.
 */
fun labelApprovalDecision(decision: ApprovalDecision): String = when (decision) {
    ApprovalDecision.Allow -> "Allow"
    ApprovalDecision.AllowAlways -> "Allow always"
    ApprovalDecision.Deny -> "Deny"
    ApprovalDecision.Cancel -> "Cancel"
    else -> decision.wire
}

/**
 * Returns what answering [request] with [decision] does, in the words of `describeApprovalAnswer`
 * in the contract, such as "Runs the command this once; the agent asks again next time." Returns
 * null for a decision this build does not know.
 */
fun describeApprovalDecision(decision: ApprovalDecision, request: ApprovalRequest): String? {
    val subject = when (request) {
        is CommandApproval -> "the command"
        is FileChangeApproval -> "the change"
        is FileReadApproval -> "the read"
        is ToolApproval -> "the tool call"
    }
    return when (decision) {
        ApprovalDecision.Allow -> "Runs $subject this once; the agent asks again next time."
        ApprovalDecision.AllowAlways -> "Runs $subject and stops asking for it while this thread keeps running."
        ApprovalDecision.Deny -> "Denies $subject; the agent is told and continues."
        ApprovalDecision.Cancel -> "Denies $subject and stops the turn."
        else -> null
    }
}

/**
 * Draws one row per decision [request] accepts. A tap gives a confirming haptic for an allow and
 * a rejecting one for a deny or a cancel, then calls [onDecide]. The rows stop answering taps
 * once the Request is [answered].
 */
@Composable
private fun ApprovalAnswers(request: ApprovalRequest, answered: Boolean, onDecide: (ApprovalDecision) -> Unit) {
    val haptics = LocalHapticFeedback.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        request.decisions.forEach { decision ->
            val allows = decision == ApprovalDecision.Allow || decision == ApprovalDecision.AllowAlways
            AnswerRow(
                icon = when (decision) {
                    ApprovalDecision.Allow -> BureauIcons.Check
                    ApprovalDecision.AllowAlways -> BureauIcons.Key
                    ApprovalDecision.Cancel -> BureauIcons.Stop
                    else -> BureauIcons.Close
                },
                title = labelApprovalDecision(decision),
                description = describeApprovalDecision(decision, request),
                look = when (decision) {
                    ApprovalDecision.Allow -> AnswerLook.Accent
                    ApprovalDecision.AllowAlways -> AnswerLook.Raised
                    else -> AnswerLook.Quiet
                },
                choice = AnswerChoice.Action,
                enabled = !answered,
                onClick = {
                    haptics.performHapticFeedback(if (allows) HapticFeedbackType.Confirm else HapticFeedbackType.Reject)
                    onDecide(decision)
                },
            )
        }
    }
}

/**
 * Draws the questions of [request], each with its options and a field for the user's own answer,
 * and a Send answers button that calls [onAnswer] once every question has an answer. Nothing
 * takes input once the Request is [answered].
 *
 * The draft is kept across a configuration change, except the text of a secret answer, which is
 * never written to the saved state.
 */
@Composable
private fun QuestionAnswersForm(request: QuestionRequest, answered: Boolean, onAnswer: (QuestionAnswers) -> Unit) {
    val colors = bureauColors
    val questions = request.detail.questions
    var draft by rememberSaveable(request.requestId, saver = buildDraftSaver(questions)) {
        mutableStateOf(buildQuestionDraft(questions))
    }
    val answers = buildQuestionAnswers(draft, questions)
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        questions.forEach { question ->
            val answer = draft.getValue(question.header)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.padding(horizontal = 4.dp)) {
                    Text(question.header, style = buildUiTextStyle(12.sp, BoldWeight), color = colors.muted)
                    Text(question.question, style = buildUiTextStyle(15.sp, MediumWeight, lineHeight = 1.35f), color = colors.ink)
                    if (question.multiSelect) {
                        Text("More than one answer may be chosen.", style = buildUiTextStyle(12.sp), color = colors.faint)
                    }
                    if (question.secret == true) {
                        Text(
                            "The agent asked to keep this answer secret. It is stored in the thread like any other answer.",
                            style = buildUiTextStyle(12.sp, lineHeight = 1.3f),
                            color = colors.youInk,
                        )
                    }
                }
                question.options.forEach { option ->
                    AnswerRow(
                        icon = if (option.label in answer.picks) BureauIcons.Check else null,
                        title = option.label,
                        description = option.description.ifBlank { null },
                        look = if (option.label in answer.picks) AnswerLook.Picked else AnswerLook.Raised,
                        choice = if (question.multiSelect) AnswerChoice.AnyOf else AnswerChoice.OneOf,
                        enabled = !answered,
                        onClick = { draft = pickQuestionOption(draft, question, option.label) },
                    )
                }
                BureauTextField(
                    answer.text,
                    { draft = typeQuestionAnswer(draft, question, it) },
                    if (question.options.isEmpty()) "Your answer" else "Or write your own answer",
                    masked = question.secret == true,
                    enabled = !answered,
                    keyboardOptions = if (question.secret == true) KeyboardOptions(keyboardType = KeyboardType.Password) else KeyboardOptions.Default,
                )
            }
        }
        BureauButton(
            "Send answers",
            onClick = { if (answers != null) onAnswer(answers) },
            modifier = Modifier.fillMaxWidth(),
            look = ButtonLook.Accent,
            size = ButtonSize.Large,
            enabled = answers != null && !answered,
        )
    }
}

/**
 * Builds the saver of a question draft. The text typed for a secret question is saved as empty,
 * so a secret never reaches the saved instance state.
 */
private fun buildDraftSaver(questions: List<Question>): Saver<MutableState<QuestionDraft>, Any> =
    listSaver(
        save = { state ->
            questions.flatMap { question ->
                val answer = state.value.getValue(question.header)
                listOf(ArrayList(answer.picks), if (question.secret == true) "" else answer.text)
            }
        },
        restore = { saved ->
            mutableStateOf(
                questions.withIndex().associate { (index, question) ->
                    val picks = (saved[index * 2] as List<*>).map { it as String }
                    question.header to QuestionDraftAnswer(picks, saved[index * 2 + 1] as String)
                },
            )
        },
    )

/** The looks of an answer row: the accent suggestion, a raised card, a picked option, or quiet. */
private enum class AnswerLook { Accent, Raised, Picked, Quiet }

/**
 * What a tap on an answer row does, which is also what TalkBack announces: an [Action] such as
 * an approval's decision, the [OneOf] option of a single-choice question, or one [AnyOf] option
 * of a question that takes several.
 */
private enum class AnswerChoice { Action, OneOf, AnyOf }

/**
 * Draws one answer, the book's `.m-ans`: [icon] (or an empty space), [title] in bold and
 * [description] below it, at least 54 dp tall. [choice] says what a tap does; a picked option
 * is drawn in the [AnswerLook.Picked] look.
 */
@Composable
private fun AnswerRow(
    icon: ImageVector?,
    title: String,
    description: String?,
    look: AnswerLook,
    choice: AnswerChoice,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = bureauColors
    val shape = RoundedCornerShape(16.dp)
    val (titleColor, descriptionColor) = when (look) {
        AnswerLook.Accent -> colors.accentFg to colors.accentFg.copy(alpha = 0.78f)
        AnswerLook.Quiet -> colors.muted to colors.muted
        AnswerLook.Raised, AnswerLook.Picked -> colors.ink to colors.muted
    }
    val surface = when (look) {
        AnswerLook.Accent -> Modifier.background(colors.accent, shape)
        AnswerLook.Raised -> Modifier.bureauShadow(BureauElevation.Resting, shape)
            .background(colors.raised, shape)
            .border(1.dp, colors.lineSoft, shape)
        AnswerLook.Picked -> Modifier.bureauShadow(BureauElevation.Resting, shape)
            .background(colors.raised, shape)
            .border(2.dp, colors.accent, shape)
        AnswerLook.Quiet -> Modifier
    }
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 54.dp)
            .then(surface)
            .clip(shape)
            .then(
                when (choice) {
                    AnswerChoice.Action -> Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick)
                    AnswerChoice.OneOf -> Modifier.selectable(look == AnswerLook.Picked, enabled = enabled, role = Role.RadioButton, onClick = onClick)
                    AnswerChoice.AnyOf -> Modifier.toggleable(look == AnswerLook.Picked, enabled = enabled, role = Role.Checkbox) { onClick() }
                },
            )
            .semantics(mergeDescendants = true) {
                if (description != null) contentDescription = "$title. $description"
            }
            .padding(horizontal = 14.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(20.dp)) {
            if (icon != null) BureauIcon(icon, if (look == AnswerLook.Accent) colors.accentFg else colors.ink, size = 20.dp)
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = buildUiTextStyle(15.sp, BoldWeight, lineHeight = 1.3f), color = titleColor)
            if (description != null) {
                Text(description, style = buildUiTextStyle(12.sp, lineHeight = 1.3f), color = descriptionColor)
            }
        }
    }
}
