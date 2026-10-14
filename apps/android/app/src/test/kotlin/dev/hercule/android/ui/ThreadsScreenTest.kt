package dev.hercule.android.ui

import androidx.compose.runtime.Composable
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.ui.fixtures.buildBookThreadsState
import dev.hercule.android.ui.fixtures.buildEmptyThreadsState
import dev.hercule.android.ui.threads.ThreadsScreen
import dev.hercule.android.ui.threads.ThreadsUiState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Draws the Threads list of the book's threads.html, light and dark: the whole list with the
 * Done shelf closed, the whole list with it open, and the empty state. The two whole lists are
 * drawn on a screen as tall as the book's page grown to fit its list, 1531 and 2205 dp, so that
 * every row is drawn.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ThreadsScreenTest {
    @Test
    @Config(qualifiers = "w390dp-h1531dp-xhdpi")
    fun drawsThreadsInWhitehaven() = captureScreen(dark = false) { DrawThreads(buildBookThreadsState(doneOpen = false)) }

    @Test
    @Config(qualifiers = "w390dp-h1531dp-night-xhdpi")
    fun drawsThreadsInOrientExpress() = captureScreen(dark = true) { DrawThreads(buildBookThreadsState(doneOpen = false)) }

    @Test
    @Config(qualifiers = "w390dp-h2205dp-xhdpi")
    fun drawsOpenDoneShelfInWhitehaven() = captureScreen(dark = false) { DrawThreads(buildBookThreadsState(doneOpen = true)) }

    @Test
    @Config(qualifiers = "w390dp-h2205dp-night-xhdpi")
    fun drawsOpenDoneShelfInOrientExpress() = captureScreen(dark = true) { DrawThreads(buildBookThreadsState(doneOpen = true)) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-xhdpi")
    fun drawsNoThreadsInWhitehaven() = captureScreen(dark = false) { DrawThreads(buildEmptyThreadsState()) }

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsNoThreadsInOrientExpress() = captureScreen(dark = true) { DrawThreads(buildEmptyThreadsState()) }
}

/** Draws [state] on the Threads screen, with no callbacks. */
@Composable
private fun DrawThreads(state: ThreadsUiState) {
    ThreadsScreen(state, onOpen = {}, onToggleDone = {}, onShowMoreDone = {}, onSelectTab = {})
}
