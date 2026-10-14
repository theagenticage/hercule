package dev.hercule.android.alerts

import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.ApprovalRequest
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.UnknownRequest

/** The buttons an alert or a Live Update shows. */
sealed interface AlertActions {
    /**
     * Allow and Deny for an approval, in that order. [decisions] holds only those of the
     * two the Request accepts. The other decisions (`allow_always`, `cancel`) are offered in
     * the app only.
     */
    data class Approve(
        val sessionId: String,
        val requestId: String,
        val decisions: List<ApprovalDecision>,
    ) : AlertActions

    /** One button per option of a single, simple question. A tap answers with that option's label. */
    data class PickOption(
        val sessionId: String,
        val requestId: String,
        /** The question's header, the key its answer goes under. */
        val header: String,
        val labels: List<String>,
    ) : AlertActions

    /** Open, for a Request the notification cannot answer. The app's docked Request answers it. */
    data object Open : AlertActions

    /**
     * Reply, for an assistant that has no open Request. The text goes to `conversation.send`.
     * [newestMessagePosition] is the position of the newest assistant message the alert shows,
     * or null when it shows none. It tells this alert apart from a newer one for the same
     * assistant, so the outcome of a reply never removes an alert the user has not seen.
     */
    data class Reply(val conversationId: String, val newestMessagePosition: Long?) : AlertActions
}

/**
 * Decides the buttons for [request], an open Request of the session [sessionId]:
 *
 * - an approval gets Allow and Deny, those of the two it accepts;
 * - a question gets one button per option when it is the Request's only question, is not
 *   `multiSelect`, is not `secret`, and has one to three options;
 * - anything else gets Open, because only the app can answer every shape of Request.
 */
fun decideAlertActions(sessionId: String, request: SessionRequest): AlertActions = when (request) {
    is ApprovalRequest -> {
        val decisions = listOf(ApprovalDecision.Allow, ApprovalDecision.Deny).filter { it in request.decisions }
        if (decisions.isEmpty()) AlertActions.Open else AlertActions.Approve(sessionId, request.requestId, decisions)
    }
    is QuestionRequest -> {
        val question = request.detail.questions.singleOrNull()
        if (question == null || question.multiSelect || question.secret == true ||
            question.options.size !in 1..MAX_OPTION_BUTTONS
        ) {
            AlertActions.Open
        } else {
            AlertActions.PickOption(sessionId, request.requestId, question.header, question.options.map { it.label })
        }
    }
    is UnknownRequest -> AlertActions.Open
}

/** Android draws at most three actions on a notification. */
private const val MAX_OPTION_BUTTONS = 3
