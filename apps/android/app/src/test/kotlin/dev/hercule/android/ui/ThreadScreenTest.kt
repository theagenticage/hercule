package dev.hercule.android.ui

import androidx.compose.runtime.Composable
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.faces.Pose
import dev.hercule.android.ui.fixtures.buildBookThreadState
import dev.hercule.android.ui.thread.ThreadScreen
import dev.hercule.android.ui.thread.ThreadUiState
import dev.hercule.android.ui.thread.WaitingBlock
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Draws the Fix thread of the book's session-active.html, light and dark: waiting on `git push`,
 * and exited on a retired runner, so it cannot be resumed.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ThreadScreenTest {
    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsThreadInWhitehaven() = captureScreen(dark = false) { DrawThread(buildBookThreadState()) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsThreadInOrientExpress() = captureScreen(dark = true) { DrawThread(buildBookThreadState()) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsThreadThatCannotBeResumedInWhitehaven() = captureScreen(dark = false) { DrawThread(buildThreadOnRetiredRunner()) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsThreadThatCannotBeResumedInOrientExpress() = captureScreen(dark = true) { DrawThread(buildThreadOnRetiredRunner()) }
}

/** Draws [state] on the Thread screen, reached from the Office. */
@Composable
private fun DrawThread(state: ThreadUiState) =
    ThreadScreen(state, onBack = {}, backLabel = "Back to the Office", onDecide = { _, _ -> }, onAnswer = { _, _ -> }, onSend = { _, _ -> })

/**
 * Returns the book's Fix thread after its session exited on a runner that was since retired: its
 * Request is gone with the session, its colleague is away, and the composer gives the reason.
 */
private fun buildThreadOnRetiredRunner(): ThreadUiState {
    val book = buildBookThreadState()
    return book.copy(
        face = book.face.copy(pose = Pose.Away),
        blocks = book.blocks.filterNot { it is WaitingBlock },
        openRequest = null,
        resumeBlockedReason = "its runner was retired",
    )
}
