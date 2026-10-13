package dev.hercule.android.alerts

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.CombinedVibration
import android.os.VibrationEffect
import android.os.VibratorManager
import androidx.core.app.RemoteInput
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.QuestionAnswers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Makes the calls an alert's buttons ask for. The service that holds the connection
 * implements it and installs itself in [current] while it runs.
 *
 * Each method returns how the call ended instead of throwing: an `invalid_state` error means
 * the Request was already answered elsewhere, which is [AlertActionOutcome.AlreadyAnswered].
 */
interface AlertActionHandler {
    /** Calls `session.respondToApprovalRequest`. */
    suspend fun respondToApproval(sessionId: String, requestId: String, decision: ApprovalDecision): AlertActionOutcome

    /** Calls `session.respondToQuestion`. */
    suspend fun respondToQuestion(sessionId: String, requestId: String, answers: QuestionAnswers): AlertActionOutcome

    /** Calls `conversation.send`. */
    suspend fun sendMessage(conversationId: String, text: String): AlertActionOutcome

    companion object {
        /** The running service's handler, or null while none runs. */
        @Volatile
        var current: AlertActionHandler? = null
    }
}

/** How a call an alert's button made ended. */
sealed interface AlertActionOutcome {
    data object Done : AlertActionOutcome

    /** The Request was answered elsewhere first (`invalid_state`). */
    data object AlreadyAnswered : AlertActionOutcome

    /** The call failed. [reason] is shown to the user as it is, such as the controller's error message. */
    data class Failed(val reason: String) : AlertActionOutcome
}

/**
 * Runs an alert's buttons: Allow once, Deny, a question's option, and Reply. A broadcast
 * runs without unlocking the phone, which an activity would not. The call itself goes to
 * [AlertActionHandler.current]; [goAsync] keeps the receiver alive until it ends.
 *
 * When the call succeeds, a thread's alert is removed. An assistant's alert and the Live
 * Update stay, because the next list posts them again with what is open then. When the call
 * fails, the alert is replaced by one that says what failed and why. When the Request was
 * already answered, the alert is just removed.
 */
class AlertActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = AlertIntents.readAction(intent) ?: return
        vibrate(context, action)
        val pending = goAsync()
        receiverScope.launch {
            try {
                val outcome = withTimeoutOrNull(CALL_TIMEOUT_MS) { call(action, intent) }
                    ?: AlertActionOutcome.Failed("the controller did not answer in time")
                finishAlertAction(context, action, outcome)
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun call(action: AlertAction, intent: Intent): AlertActionOutcome {
        val handler = AlertActionHandler.current
            ?: return AlertActionOutcome.Failed("Hercule is not connected to the controller")
        return when (action) {
            is AlertAction.Decide -> handler.respondToApproval(action.sessionId, action.requestId, action.decision)
            is AlertAction.Pick -> handler.respondToQuestion(
                action.sessionId,
                action.requestId,
                mapOf(action.header to listOf(action.label)),
            )
            is AlertAction.SendReply -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(AlertIntents.KEY_REPLY_TEXT)
                    ?.toString()?.trim().orEmpty()
                if (text.isEmpty()) AlertActionOutcome.Failed("the reply was empty") else handler.sendMessage(action.conversationId, text)
            }
        }
    }

    /** Confirms the tap: a click for Allow once and for an option, a double click for Deny, nothing for Reply. */
    private fun vibrate(context: Context, action: AlertAction) {
        val effect = when {
            action is AlertAction.SendReply -> return
            action is AlertAction.Decide && action.decision == ApprovalDecision.Deny -> VibrationEffect.EFFECT_DOUBLE_CLICK
            else -> VibrationEffect.EFFECT_CLICK
        }
        context.getSystemService(VibratorManager::class.java)
            ?.vibrate(CombinedVibration.createParallel(VibrationEffect.createPredefined(effect)))
    }

    private companion object {
        /** A receiver that called goAsync() must finish within about ten seconds. */
        const val CALL_TIMEOUT_MS = 9_000L

        val receiverScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}
