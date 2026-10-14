package dev.hercule.android.ui

import dev.hercule.android.office.buildProject
import dev.hercule.android.theme.WhitehavenColors
import kotlin.test.assertEquals
import org.junit.Test

/**
 * Tests [pickProjectTint] with the `pickProjectHue` cases of
 * packages/client-core/src/threads/tone.test.ts that use the desktop's three Bureau tints. The
 * case of the web app's two tones is left out, because the port has only the three tints.
 */
class ProjectTintTest {
    private val colors = WhitehavenColors
    private val webshop = colors.projWebshop
    private val payments = colors.projPayments
    private val ops = colors.projOps

    private val projects = listOf("webshop", "payments-api", "ops", "billing", "search").map { buildProject("p-$it", it) }

    @Test
    fun `counts the project's position round a palette of three`() {
        assertEquals(
            listOf(webshop, payments, ops, webshop, payments),
            projects.map { pickProjectTint(it, projects, colors) },
        )
    }

    @Test
    fun `follows the project list, so two projects shown next to each other in another order can share a tint`() {
        // The sidebar orders projects by their latest thread, not by the project list, so
        // "billing" can sit right above "webshop". Each keeps the tint its position in the
        // project list gives it, and the two match.
        val sidebarOrder = listOf(projects[3], projects[0])

        assertEquals(listOf(webshop, webshop), sidebarOrder.map { pickProjectTint(it, projects, colors) })
    }

    @Test
    fun `returns the first tint for a project that is not in the list`() {
        assertEquals(webshop, pickProjectTint(buildProject("p-gone", "gone"), projects, colors))
    }
}
