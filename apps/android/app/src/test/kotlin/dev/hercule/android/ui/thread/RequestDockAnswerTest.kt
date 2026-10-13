package dev.hercule.android.ui.thread

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.ui.BureauTheme
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.CommandApproval
import kotlin.test.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Tests that a tap on the dock answers the Request the dock draws. The screen's state can move
 * on to a newer Request before the dock is drawn again, so the answer must not read it there.
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
}
