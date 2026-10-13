package dev.hercule.android.app

import dev.hercule.android.alerts.AlertActionOutcome
import dev.hercule.android.controller.MockController
import dev.hercule.android.wire.ApprovalDecision
import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import org.junit.After
import org.junit.Test

/** Tests how the handler maps the controller's answers to an alert button's outcome. */
class ControllerAlertActionHandlerTest {
    private var reply: MockResponse = MockResponse.Builder().code(404).build()
    private val controller = MockController { reply }
    private val handler = ControllerAlertActionHandler(controller.buildApi())

    @After
    fun stopController() = controller.close()

    private fun respondWithError(status: Int, code: String, message: String) {
        reply = MockResponse.Builder().code(status).body("""{"error":{"code":"$code","message":"$message"}}""").build()
    }

    @Test
    fun `a call the controller accepts is done`() = runTest {
        reply = MockResponse.Builder().body(CONVERSATION_MESSAGE_JSON).build()
        assertEquals(AlertActionOutcome.Done, handler.sendMessage("c1", "On it"))
    }

    @Test
    fun `a Request answered elsewhere first is already answered`() = runTest {
        respondWithError(409, "invalid_state", "the request is no longer open")
        assertEquals(AlertActionOutcome.AlreadyAnswered, handler.respondToApproval("s1", "r1", ApprovalDecision.Allow))
    }

    @Test
    fun `any other error fails with the controller's message`() = runTest {
        respondWithError(403, "forbidden", "this key may not answer requests")
        assertEquals(AlertActionOutcome.Failed("this key may not answer requests"), handler.sendMessage("c1", "On it"))
    }

    @Test
    fun `an unreachable controller fails with a plain reason`() = runTest {
        controller.close()
        assertEquals(
            AlertActionOutcome.Failed("the controller could not be reached"),
            handler.respondToQuestion("s1", "r1", mapOf("Region" to listOf("eu-west"))),
        )
    }
}

private const val CONVERSATION_MESSAGE_JSON =
    """{"id":"m1","conversationId":"c1","containerKey":null,"position":1,"senderRole":"owner","senderLabel":"You","text":"On it","sessionId":null,"turnId":null,"itemId":null,"actor":"user","createdAt":"2026-10-12T22:10:00.000Z"}"""
