package dev.hercule.android.ui

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.fixtures.buildBookThreadState
import dev.hercule.android.ui.thread.ThreadScreen
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Draws the Fix thread of the book's session-active.html, waiting on `git push`, light and dark. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ThreadScreenTest {
    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsThreadInWhitehaven() = captureScreen(dark = false) { ThreadScreen(buildBookThreadState(), onBack = {}, onDecide = { _, _ -> }, onAnswer = { _, _ -> }, onSend = { _, _ -> }) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsThreadInOrientExpress() = captureScreen(dark = true) { ThreadScreen(buildBookThreadState(), onBack = {}, onDecide = { _, _ -> }, onAnswer = { _, _ -> }, onSend = { _, _ -> }) }
}
