package dev.hercule.android.alerts

import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionOption
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.UnknownRequest
import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonObject
import org.junit.Test

/** Tests which buttons an alert offers for each shape of Request. */
class AlertActionsTest {
    @Test
    fun `offers allow and deny for an approval`() {
        val decisions = listOf(ApprovalDecision.Allow, ApprovalDecision.AllowAlways, ApprovalDecision.Deny, ApprovalDecision.Cancel)
        assertEquals(
            AlertActions.Approve("s1", "r1", listOf(ApprovalDecision.Allow, ApprovalDecision.Deny)),
            decideAlertActions("s1", buildCommand("r1", decisions = decisions)),
        )
    }

    @Test
    fun `offers only the decisions the approval accepts, and open when it accepts neither`() {
        assertEquals(
            AlertActions.Approve("s1", "r1", listOf(ApprovalDecision.Deny)),
            decideAlertActions("s1", buildCommand("r1", decisions = listOf(ApprovalDecision.Deny, ApprovalDecision.Cancel))),
        )
        assertEquals(AlertActions.Open, decideAlertActions("s1", buildCommand("r1", decisions = listOf(ApprovalDecision.AllowAlways))))
    }

    @Test
    fun `offers one button per option of a single simple question`() {
        assertEquals(
            AlertActions.PickOption("s1", "r1", "Region", listOf("eu-west", "us-east")),
            decideAlertActions("s1", buildQuestion("r1")),
        )
    }

    @Test
    fun `offers buttons for an async question whose options have no description`() {
        val asked = Question("Which region should the rollout start in?", "Question", listOf(QuestionOption("eu-west"), QuestionOption("us-east")), multiSelect = false)
        val request = QuestionRequest("r1", "item-r1", QuestionRequest.Detail(listOf(asked)), async = true)

        assertEquals(AlertActions.PickOption("s1", "r1", "Question", listOf("eu-west", "us-east")), decideAlertActions("s1", request))
    }

    @Test
    fun `offers open for a question the buttons cannot answer`() {
        val shapes = listOf(
            buildQuestion("r1", buildAsked(), buildAsked(header = "Time")),
            buildQuestion("r1", buildAsked(multiSelect = true)),
            buildQuestion("r1", buildAsked(secret = true)),
            buildQuestion("r1", buildAsked(options = emptyList())),
            buildQuestion("r1", buildAsked(options = listOf("a", "b", "c", "d"))),
        )
        for (shape in shapes) assertEquals(AlertActions.Open, decideAlertActions("s1", shape), "for $shape")
    }

    @Test
    fun `offers open for a Request of a kind this build does not know`() {
        assertEquals(AlertActions.Open, decideAlertActions("s1", UnknownRequest(JsonObject(emptyMap()))))
    }
}
