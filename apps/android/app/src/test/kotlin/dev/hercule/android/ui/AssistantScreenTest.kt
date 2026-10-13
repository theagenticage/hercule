package dev.hercule.android.ui

import androidx.compose.runtime.Composable
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.assistant.AssistantScreen
import dev.hercule.android.ui.assistant.AssistantUiState
import dev.hercule.android.ui.assistant.SpeechInput
import dev.hercule.android.ui.fixtures.buildBookAssistantState
import dev.hercule.android.ui.fixtures.buildBookThreadState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Draws Ada's conversation of the book's assistant.html, light and dark, with the mic drawn,
 * and once more with a Request of Ada's session docked above the composer.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AssistantScreenTest {
    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsAssistantInWhitehaven() = captureScreen(dark = false) { DrawAssistant(buildBookAssistantState()) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsAssistantInOrientExpress() = captureScreen(dark = true) { DrawAssistant(buildBookAssistantState()) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsAssistantWithDockedRequest() = captureScreen(dark = false) {
        DrawAssistant(buildBookAssistantState().copy(sessionId = "s-ada", openRequest = buildBookThreadState().openRequest))
    }
}

/** Draws the Assistant screen for [state], with every callback doing nothing. */
@Composable
private fun DrawAssistant(state: AssistantUiState) =
    AssistantScreen(state, onBack = {}, onSend = { _, _ -> }, onDecide = { _, _ -> }, onAnswer = { _, _ -> }, speechInput = AvailableSpeechInput)

/** A recognizer that is available and hears nothing, so the screen draws its mic. */
private object AvailableSpeechInput : SpeechInput {
    override fun start(onResult: (text: String?) -> Unit) = Unit

    override fun stop() = Unit
}
