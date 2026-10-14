package dev.hercule.android.app

import dev.hercule.android.alerts.AlertActionHandler
import dev.hercule.android.alerts.AlertActionOutcome
import dev.hercule.android.controller.ControllerApi
import dev.hercule.android.controller.ControllerApiException
import dev.hercule.android.wire.ApiErrorCode
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.QuestionAnswers
import java.io.IOException
import kotlinx.serialization.SerializationException

/** Makes the calls of an alert's buttons with [api]. */
class ControllerAlertActionHandler(private val api: ControllerApi) : AlertActionHandler {
    override suspend fun respondToApproval(sessionId: String, requestId: String, decision: ApprovalDecision) =
        runAlertCall { api.respondToApprovalRequest(sessionId, requestId, decision) }

    override suspend fun respondToQuestion(sessionId: String, requestId: String, answers: QuestionAnswers) =
        runAlertCall { api.respondToQuestion(sessionId, requestId, answers) }

    override suspend fun sendMessage(conversationId: String, text: String) =
        runAlertCall { api.sendConversationMessage(conversationId, text) }
}

/**
 * Runs [call] and returns how it ended:
 *
 * - [AlertActionOutcome.Done] when it returns;
 * - [AlertActionOutcome.AlreadyAnswered] on `invalid_state`, which the controller answers
 *   when the Request was answered elsewhere first;
 * - [AlertActionOutcome.Failed] with the controller's message on any other error, and with a
 *   plain reason when the controller cannot be reached or its reply cannot be read.
 */
internal suspend fun runAlertCall(call: suspend () -> Unit): AlertActionOutcome = try {
    call()
    AlertActionOutcome.Done
} catch (e: ControllerApiException) {
    if (e.error.code == ApiErrorCode.InvalidState) AlertActionOutcome.AlreadyAnswered else AlertActionOutcome.Failed(e.error.message)
} catch (_: IOException) {
    AlertActionOutcome.Failed("the controller could not be reached")
} catch (_: SerializationException) {
    AlertActionOutcome.Failed("the controller's reply could not be read")
}
