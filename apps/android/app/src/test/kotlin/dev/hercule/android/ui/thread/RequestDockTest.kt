package dev.hercule.android.ui.thread

import dev.hercule.android.ui.TextRun
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.CommandApproval
import dev.hercule.android.wire.FileChangeApproval
import dev.hercule.android.wire.FileReadApproval
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.ToolApproval
import kotlin.test.assertEquals
import org.junit.Test

/** Tests [buildDockTitle], the title of the docked Request and of the Office's ask card. */
class RequestDockTest {
    private val decisions = listOf(ApprovalDecision.Allow, ApprovalDecision.Deny)

    private fun code(text: String) = TextRun(text, true)

    private fun plain(text: String) = TextRun(text, false)

    @Test
    fun `asks to run a command, with the command as code`() {
        val title = buildDockTitle(CommandApproval("r", "i", CommandApproval.Detail("git push"), decisions))

        assertEquals(listOf(plain("Run "), code("git push"), plain("?")), title)
    }

    @Test
    fun `asks to run this command when the command is blank`() {
        assertEquals(listOf(plain("Run this command?")), buildDockTitle(CommandApproval("r", "i", CommandApproval.Detail(" "), decisions)))
    }

    @Test
    fun `names one file as code, and lists several after the question`() {
        assertEquals(
            listOf(plain("Change "), code("src/a.ts"), plain("?")),
            buildDockTitle(FileChangeApproval("r", "i", FileChangeApproval.Detail(listOf("src/a.ts")), decisions)),
        )
        assertEquals(
            listOf(plain("Read these files? "), code("a.ts"), plain(" "), code("b.ts")),
            buildDockTitle(FileReadApproval("r", "i", FileReadApproval.Detail(listOf("a.ts", "b.ts")), decisions)),
        )
        assertEquals(
            listOf(plain("Change files?")),
            buildDockTitle(FileChangeApproval("r", "i", FileChangeApproval.Detail(emptyList()), decisions)),
        )
    }

    @Test
    fun `names the tool, and asks for answers on a question`() {
        assertEquals(
            listOf(plain("Run "), code("WebFetch"), plain("?")),
            buildDockTitle(ToolApproval("r", "i", ToolApproval.Detail("WebFetch"), decisions)),
        )
        assertEquals(
            listOf(plain("The agent needs answers.")),
            buildDockTitle(QuestionRequest("r", "i", QuestionRequest.Detail(emptyList()))),
        )
    }
}
