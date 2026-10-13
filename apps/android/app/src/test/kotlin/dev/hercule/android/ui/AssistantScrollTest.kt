package dev.hercule.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.assistant.AssistantScreen
import dev.hercule.android.ui.fixtures.buildAdaMessage
import dev.hercule.android.ui.fixtures.buildBookAssistantState
import dev.hercule.android.wire.ConversationSenderRole
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Checks that Ada's conversation follows its newest message: a new message comes into view
 * while the user is at the newest one, and always when the user sent it. A reply that arrives
 * while the user reads older messages leaves them where they are.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
class AssistantScrollTest {
    @get:Rule
    val compose = createComposeRule()

    private var state by mutableStateOf(
        buildBookAssistantState().copy(
            answering = false,
            answerSoFar = null,
            reminder = null,
            messages = (1L..30L).map { buildAdaMessage(it, ConversationSenderRole.Assistant, "Ada", "2026-09-29T09:00:00Z", "Older message $it") },
        ),
    )

    @Test
    fun showsTheUsersNewMessage() {
        drawAssistant()
        addMessage(ConversationSenderRole.Owner, "Is the backup job fixed yet?")
        compose.onNodeWithText("Is the backup job fixed yet?").assertIsDisplayed()
    }

    @Test
    fun showsANewReplyWhileAtTheNewestMessage() {
        drawAssistant()
        addMessage(ConversationSenderRole.Assistant, "Not yet.")
        compose.onNodeWithText("Not yet.").assertIsDisplayed()
    }

    @Test
    fun keepsOlderMessagesInViewWhenAReplyArrives() {
        drawAssistant()
        scrollToOldest()
        addMessage(ConversationSenderRole.Assistant, "Not yet.")
        compose.onNodeWithText("Older message 1").assertIsDisplayed()
    }

    @Test
    fun showsTheUsersNewMessageAfterScrollingBack() {
        drawAssistant()
        scrollToOldest()
        addMessage(ConversationSenderRole.Owner, "Is the backup job fixed yet?")
        compose.onNodeWithText("Is the backup job fixed yet?").assertIsDisplayed()
        compose.onNodeWithText("Older message 1").assertIsNotDisplayed()
    }

    private fun drawAssistant() {
        compose.setContent {
            BureauTheme(dark = false) {
                AssistantScreen(state, onBack = {}, onSend = { _, _ -> }, onDecide = {}, onAnswer = {}, speechInput = null)
            }
        }
        compose.onNodeWithText("Older message 30").assertIsDisplayed()
    }

    private fun scrollToOldest() {
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText("Older message 1"))
        compose.onNodeWithText("Older message 30").assertIsNotDisplayed()
    }

    private fun addMessage(role: ConversationSenderRole, text: String) {
        val position = state.messages.size + 1L
        state = state.copy(messages = state.messages + buildAdaMessage(position, role, if (role == ConversationSenderRole.Owner) "rogier" else "Ada", "2026-09-29T09:40:00Z", text))
        compose.waitForIdle()
    }
}
