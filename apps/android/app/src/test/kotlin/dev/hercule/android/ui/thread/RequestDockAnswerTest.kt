package dev.hercule.android.ui.thread

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.ui.BureauTheme
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.CommandApproval
import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionAnswers
import dev.hercule.android.wire.QuestionOption
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.SessionRequest
import kotlin.test.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Tests that the dock answers, and keeps a draft for, the Request it draws. The screen's state
 * can move on to a newer Request before the dock is drawn again, so neither may read it there.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
class RequestDockAnswerTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `a tap on Allow answers the drawn Request by its id`() {
        val decided = mutableListOf<Pair<String, ApprovalDecision>>()
        val request = CommandApproval("r-test", "i", CommandApproval.Detail("pnpm test"), listOf(ApprovalDecision.Allow, ApprovalDecision.Deny))
        compose.setContent {
            BureauTheme(dark = false) {
                RequestDock(
                    request,
                    OfficeFace("s", Pose.Waiting, isAssistant = false),
                    answered = false,
                    onDecide = { requestId, decision -> decided += requestId to decision },
                    onAnswer = { _, _ -> },
                )
            }
        }

        compose.onNodeWithText("Allow").performClick()

        assertEquals(listOf("r-test" to ApprovalDecision.Allow), decided)
    }

    @Test
    fun `a draft saved for one Request is not restored into a newer one`() {
        val pickedRequest = buildQuestionRequest("r-old", listOf("Branch"))
        var request: SessionRequest = pickedRequest
        val restoration = StateRestorationTester(compose)
        restoration.setContent {
            BureauTheme(dark = false) {
                RequestDock(request, OfficeFace("s", Pose.Waiting, isAssistant = false), answered = false, onDecide = { _, _ -> }, onAnswer = { _, _ -> })
            }
        }
        compose.onNodeWithText("main").performClick()

        // The process is recreated while a newer Request with two questions is open.
        request = buildQuestionRequest("r-new", listOf("Branch", "Remote"))
        restoration.emulateSavedInstanceStateRestore()

        compose.onNodeWithText("Send answers").assertIsNotEnabled()
    }

    @Test
    fun `a failed answer unlocks the form with the picked option still in the draft`() {
        var answered by mutableStateOf(false)
        val sent = mutableListOf<QuestionAnswers>()
        compose.setContent {
            BureauTheme(dark = false) {
                RequestDock(
                    buildQuestionRequest("r-1", listOf("Branch")),
                    OfficeFace("s", Pose.Waiting, isAssistant = false),
                    answered = answered,
                    onDecide = { _, _ -> },
                    onAnswer = { _, answers -> sent += answers },
                )
            }
        }
        compose.onNodeWithText("main").performClick()
        compose.onNodeWithText("Send answers").performClick()
        // The screen marks the Request answered while the call runs, and unmarks it when it fails.
        answered = true
        compose.onNodeWithText("Send answers").assertIsNotEnabled()
        answered = false

        compose.onNodeWithText("Send answers").assertIsEnabled().performClick()

        assertEquals(listOf(mapOf("Branch" to listOf("main")), mapOf("Branch" to listOf("main"))), sent)
    }

    @Test
    fun `answers an async question that offers no options with the text typed`() {
        val sent = mutableListOf<QuestionAnswers>()
        val request = QuestionRequest(
            "r-async",
            "i",
            QuestionRequest.Detail(listOf(Question("Which environment should I deploy to?", "Question", emptyList(), multiSelect = false))),
            async = true,
        )
        compose.setContent {
            BureauTheme(dark = false) {
                RequestDock(
                    request,
                    OfficeFace("s", Pose.Waiting, isAssistant = false),
                    answered = false,
                    onDecide = { _, _ -> },
                    onAnswer = { _, answers -> sent += answers },
                )
            }
        }
        compose.onNodeWithText("Send answers").assertIsNotEnabled()

        compose.onNodeWithText("Your answer").performTextInput("staging")
        compose.onNodeWithText("Send answers").performClick()

        assertEquals(listOf(mapOf("Question" to listOf("staging"))), sent)
    }

    /** Builds a question Request with one question per header, each offering "main" and "dev". */
    private fun buildQuestionRequest(requestId: String, headers: List<String>) = QuestionRequest(
        requestId,
        "i",
        QuestionRequest.Detail(
            headers.map { header ->
                Question("Which $header?", header, listOf(QuestionOption("main", ""), QuestionOption("dev", "")), multiSelect = false)
            },
        ),
    )
}
