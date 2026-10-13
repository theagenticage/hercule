package dev.hercule.android.ui.office

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hercule.android.office.OfficeRow
import dev.hercule.android.ui.BureauTheme
import dev.hercule.android.ui.fixtures.buildBookOfficeState
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Tests that an asleep assistant can be opened from the Office. It has no row in the lanes, so
 * the Lobby wing it sits in is the only place to tap it.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w390dp-h844dp-xhdpi")
class OfficeLobbyTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `a tap on the Lobby opens the one assistant asleep in it`() {
        val opened = mutableListOf<OfficeRow>()
        compose.setContent {
            BureauTheme(dark = false) {
                OfficeScreen(buildBookOfficeState(), onOpen = { opened += it }, onDecide = { _, _ -> }, onSelectTab = {})
            }
        }

        compose.onNodeWithText("Lobby").performClick()

        assertEquals(listOf("Juno"), opened.map { it.title })
        assertNotNull(opened.single().assistantId)
    }
}
