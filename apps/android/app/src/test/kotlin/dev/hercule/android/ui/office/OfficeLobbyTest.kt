package dev.hercule.android.ui.office

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.captureScreenRoboImage
import dev.hercule.android.office.OfficeRow
import dev.hercule.android.ui.BureauTheme
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.fixtures.buildBookOfficeState
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Tests that an asleep assistant can be opened from the Office. It has no row in the lanes, so
 * the Lobby wing it sits in is the only place to tap it. Draws the menu of the asleep
 * assistants the Lobby has no room for, light and dark.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
class OfficeLobbyTest {
    @get:Rule
    val compose = createComposeRule()

    private val opened = mutableListOf<OfficeRow>()

    @Test
    fun `a tap on the Lobby opens the one assistant asleep in it`() {
        showOffice(buildBookOfficeState(), dark = false)

        compose.onNodeWithText("Lobby").performClick()

        assertEquals(listOf("Juno"), opened.map { it.title })
        assertNotNull(opened.single().assistantId)
    }

    @Test
    fun `the plus count opens a menu of the assistants it counts, and a row opens its assistant`() {
        showOffice(buildCrowdedLobbyState(), dark = false)

        compose.onNodeWithText("+2").performClick()
        compose.onNodeWithText("Assistant 5").performClick()

        assertEquals(listOf("Assistant 5"), opened.map { it.title })
        compose.onNodeWithText("Assistant 4").assertDoesNotExist()
    }

    @Test
    fun drawsLobbyMenuInWhitehaven() = captureLobbyMenu(dark = false)

    @Test
    @Config(qualifiers = "w390dp-h844dp-night-xhdpi")
    fun drawsLobbyMenuInOrientExpress() = captureLobbyMenu(dark = true)

    // The menu is a popup, a window of its own, which only a capture of the whole screen includes.
    @OptIn(ExperimentalRoborazziApi::class)
    private fun captureLobbyMenu(dark: Boolean) {
        showOffice(buildCrowdedLobbyState(), dark)
        compose.onNodeWithText("+2").performClick()
        compose.waitForIdle()
        captureScreenRoboImage()
    }

    private fun showOffice(state: OfficeUiState, dark: Boolean) {
        compose.setContent {
            BureauTheme(dark = dark) {
                Box(Modifier.fillMaxSize().background(bureauColors.bg)) {
                    OfficeScreen(state, onOpen = { opened += it }, onDecide = { _, _ -> }, onSelectTab = {})
                }
            }
        }
    }

    /** Returns the book's Office with six assistants asleep in the Lobby, two more than it draws. */
    private fun buildCrowdedLobbyState(): OfficeUiState {
        val state = buildBookOfficeState()
        val juno = state.office.lobby.single()
        val lobby = List(6) { juno.copy(assistantId = "a-$it", title = "Assistant $it") }
        return state.copy(office = state.office.copy(lobby = lobby))
    }
}
