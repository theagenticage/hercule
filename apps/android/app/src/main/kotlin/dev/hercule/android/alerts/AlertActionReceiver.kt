package dev.hercule.android.alerts

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.CombinedVibration
import android.os.VibrationEffect
import android.os.VibratorManager
import androidx.core.app.RemoteInput
import dev.hercule.android.appGraph
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.QuestionAnswers
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Makes the calls an alert's buttons ask for, over plain HTTP. It needs only the stored
 * credentials, not the live connection, so a button works even when Android killed the
 * process and the tap started a new one.
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
 * runs without unlocking the phone, which an activity would not. The call itself goes to the
 * handler the app graph opens from the stored credentials; [goAsync] keeps the receiver alive
 * until it ends.
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
        val graph = context.appGraph
        receiverScope.launch {
            try {
                val replyText = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(AlertIntents.KEY_REPLY_TEXT)?.toString()
                val outcome = try {
                    callAlertAction(graph::openAlertActionHandler, action, replyText)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // A failure the handler does not map, such as a damaged credential file,
                    // must not crash the process: the user still learns that the tap failed.
                    AlertActionOutcome.Failed(e.message ?: e.javaClass.simpleName)
                }
                finishAlertAction(context, action, outcome)
            } finally {
                pending.finish()
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
        val receiverScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}

/**
 * Makes the call [action] asks for through the handler [openHandler] returns, and returns how
 * it ended. [openHandler] returns null when nobody is signed in. [replyText] is the text typed
 * into Reply, or null for any other button.
 *
 * Returns [AlertActionOutcome.Failed] when nobody is signed in, when the reply is blank, or
 * when opening the handler and the call together take longer than [CALL_TIMEOUT_MS]. Fails
 * only with what [openHandler] or the handler throws.
 */
internal suspend fun callAlertAction(
    openHandler: suspend () -> AlertActionHandler?,
    action: AlertAction,
    replyText: String?,
): AlertActionOutcome {
    val text = replyText?.trim().orEmpty()
    if (action is AlertAction.SendReply && text.isEmpty()) return AlertActionOutcome.Failed("the reply was empty")
    return withTimeoutOrNull(CALL_TIMEOUT_MS) {
        val handler = openHandler() ?: return@withTimeoutOrNull AlertActionOutcome.Failed("you are signed out of the controller")
        when (action) {
            is AlertAction.Decide -> handler.respondToApproval(action.sessionId, action.requestId, action.decision)
            is AlertAction.Pick -> handler.respondToQuestion(action.sessionId, action.requestId, mapOf(action.header to listOf(action.label)))
            is AlertAction.SendReply -> handler.sendMessage(action.conversationId, text)
        }
    } ?: AlertActionOutcome.Failed("the controller did not answer in time")
}

/** A receiver that called goAsync() must finish within about ten seconds. */
internal const val CALL_TIMEOUT_MS = 9_000L
