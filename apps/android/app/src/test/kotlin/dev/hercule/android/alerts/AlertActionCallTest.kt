package dev.hercule.android.alerts

import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.QuestionAnswers
import kotlin.test.assertEquals
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runTest
import org.junit.Test

/** Tests the call an alert's button makes, against a handler that records what it was asked. */
class AlertActionCallTest {
    private val thread = ThreadAlertKey("s1")
    private val allow = AlertAction.Decide(thread, THREAD_ALERT_ID, "Fix checkout", "Allow", "s1", "r1", ApprovalDecision.Allow)
    private val reply = AlertAction.SendReply(AssistantAlertKey("a1"), ASSISTANT_ALERT_ID, "Poirot", "Reply", "c1")

    private class RecordingHandler(private val outcome: AlertActionOutcome = AlertActionOutcome.Done) : AlertActionHandler {
        val calls = mutableListOf<String>()

        override suspend fun respondToApproval(sessionId: String, requestId: String, decision: ApprovalDecision) =
            outcome.also { calls += "approve $sessionId $requestId ${decision.wire}" }

        override suspend fun respondToQuestion(sessionId: String, requestId: String, answers: QuestionAnswers) =
            outcome.also { calls += "answer $sessionId $requestId $answers" }

        override suspend fun sendMessage(conversationId: String, text: String) =
            outcome.also { calls += "send $conversationId $text" }
    }

    @Test
    fun `passes each button to its call and returns the handler's outcome`() = runTest {
        val handler = RecordingHandler(AlertActionOutcome.AlreadyAnswered)
        val pick = AlertAction.Pick(thread, THREAD_ALERT_ID, "Fix checkout", "eu-west", "s1", "r2", "Region", "eu-west")

        assertEquals(AlertActionOutcome.AlreadyAnswered, callAlertAction({ handler }, allow, null))
        callAlertAction({ handler }, pick, null)
        callAlertAction({ handler }, reply, "  On it  ")

        assertEquals(listOf("approve s1 r1 allow", "answer s1 r2 {Region=[eu-west]}", "send c1 On it"), handler.calls)
    }

    @Test
    fun `fails when nobody is signed in`() = runTest {
        assertEquals(AlertActionOutcome.Failed("you are signed out of the controller"), callAlertAction({ null }, allow, null))
    }

    @Test
    fun `fails a blank reply without sending it`() = runTest {
        val handler = RecordingHandler()
        assertEquals(AlertActionOutcome.Failed("the reply was empty"), callAlertAction({ handler }, reply, " \n"))
        assertEquals(emptyList(), handler.calls)
    }

    @Test
    fun `fails when the controller does not answer in time`() = runTest {
        val silent = object : AlertActionHandler {
            override suspend fun respondToApproval(sessionId: String, requestId: String, decision: ApprovalDecision): AlertActionOutcome = awaitCancellation()
            override suspend fun respondToQuestion(sessionId: String, requestId: String, answers: QuestionAnswers): AlertActionOutcome = awaitCancellation()
            override suspend fun sendMessage(conversationId: String, text: String): AlertActionOutcome = awaitCancellation()
        }
        assertEquals(AlertActionOutcome.Failed("the controller did not answer in time"), callAlertAction({ silent }, allow, null))
    }
}
