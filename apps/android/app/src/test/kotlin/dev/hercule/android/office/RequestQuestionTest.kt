package dev.hercule.android.office

import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.FileChangeApproval
import dev.hercule.android.wire.FileReadApproval
import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.ToolApproval
import dev.hercule.android.wire.UnknownRequest
import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Test

/**
 * Tests [formatRequestQuestion]. The cases are copied one for one from
 * packages/client-core/src/threads/request-question.test.ts; the last case is the app's own.
 */
class RequestQuestionTest {
    private val decisions = listOf(ApprovalDecision.Allow, ApprovalDecision.Deny)

    private fun formatCommand(command: String) = formatRequestQuestion(buildCommandRequest("req-1", command))

    private fun formatFileChange(vararg paths: String) = formatRequestQuestion(
        FileChangeApproval("req-1", "tool-1", FileChangeApproval.Detail(paths.toList()), decisions),
    )

    private fun formatFileRead(vararg paths: String) = formatRequestQuestion(
        FileReadApproval("req-1", "tool-1", FileReadApproval.Detail(paths.toList()), decisions),
    )

    @Test
    fun `asks to run a command`() {
        assertEquals("Run git push?", formatCommand("git push"))
    }

    @Test
    fun `asks to run only the first non-empty line of a multi-line command`() {
        assertEquals("Run cat <<EOF > notes.txt?", formatCommand("\n  cat <<EOF > notes.txt\nhello\nEOF\n"))
    }

    @Test
    fun `asks to run this command when the harness sent none`() {
        assertEquals("Run this command?", formatCommand(" \n"))
    }

    @Test
    fun `names the one file a change touches, by its file name`() {
        assertEquals("Change secure.ts?", formatFileChange("src/checkout/secure.ts"))
    }

    @Test
    fun `counts the files a change touches when there are several`() {
        assertEquals("Change 3 files?", formatFileChange("a.ts", "b/c.ts", "d.ts"))
    }

    @Test
    fun `asks about files in general when the harness named none`() {
        assertEquals("Change files?", formatFileChange())
    }

    @Test
    fun `names the one file a read touches, or counts several`() {
        assertEquals("Read hosts?", formatFileRead("/etc/hosts"))
        assertEquals("Read 2 files?", formatFileRead("a.md", "b.md"))
    }

    @Test
    fun `names a directory by its last part, and the root by its whole path`() {
        assertEquals("Read src?", formatFileRead("/Users/x/src/"))
        assertEquals("Read src?", formatFileRead("src//"))
        assertEquals("Read /?", formatFileRead("/"))
    }

    @Test
    fun `asks to run a tool by its name`() {
        assertEquals(
            "Run WebFetch?",
            formatRequestQuestion(ToolApproval("req-1", "tool-1", ToolApproval.Detail("WebFetch"), decisions)),
        )
    }

    @Test
    fun `uses the first question, in the agent's words`() {
        val request = QuestionRequest(
            "req-1",
            "tool-1",
            QuestionRequest.Detail(
                listOf(
                    Question("Which region should the rollout start in?", "Region", emptyList(), multiSelect = false),
                    Question("When?", "Time", emptyList(), multiSelect = false),
                ),
            ),
        )
        assertEquals("Which region should the rollout start in?", formatRequestQuestion(request))
    }

    // Not from client-core: the desktop's contract has no unknown kind.
    @Test
    fun `asks to answer a Request whose kind this build does not know`() {
        val request = UnknownRequest(
            buildJsonObject {
                put("kind", JsonPrimitive("plan_approval"))
                put("requestId", JsonPrimitive("req-1"))
                put("itemId", JsonPrimitive("tool-1"))
            },
        )
        assertEquals("Answer this request?", formatRequestQuestion(request))
    }
}
