package dev.hercule.android.ui

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.assistant.AssistantScreen
import dev.hercule.android.ui.assistant.SpeechInput
import dev.hercule.android.ui.fixtures.buildBookAssistantState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Draws Ada's conversation of the book's assistant.html, light and dark, with the mic drawn. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AssistantScreenTest {
    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsAssistantInWhitehaven() = captureScreen(dark = false) { AssistantScreen(buildBookAssistantState(), onBack = {}, onSend = {}, speechInput = AvailableSpeechInput) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsAssistantInOrientExpress() = captureScreen(dark = true) { AssistantScreen(buildBookAssistantState(), onBack = {}, onSend = {}, speechInput = AvailableSpeechInput) }
}

/** A recognizer that is available and hears nothing, so the screen draws its mic. */
private object AvailableSpeechInput : SpeechInput {
    override fun start(onText: (String) -> Unit) = Unit

    override fun stop() = Unit
}
