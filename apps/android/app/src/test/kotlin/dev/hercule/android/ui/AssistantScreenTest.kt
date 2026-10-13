package dev.hercule.android.ui

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.assistant.AssistantScreen
import dev.hercule.android.ui.fixtures.buildBookAssistantState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Draws Ada's conversation of the book's assistant.html, with no mic, light and dark. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AssistantScreenTest {
    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsAssistantInWhitehaven() = captureScreen(dark = false) { AssistantScreen(buildBookAssistantState(), onBack = {}, onSend = {}, speechInput = null) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsAssistantInOrientExpress() = captureScreen(dark = true) { AssistantScreen(buildBookAssistantState(), onBack = {}, onSend = {}, speechInput = null) }
}
