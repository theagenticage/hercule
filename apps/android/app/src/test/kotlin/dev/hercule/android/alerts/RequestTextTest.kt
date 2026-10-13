package dev.hercule.android.alerts

import dev.hercule.android.wire.FileChangeApproval
import dev.hercule.android.wire.FileReadApproval
import dev.hercule.android.wire.ToolApproval
import dev.hercule.android.wire.UnknownRequest
import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test

/**
 * Tests the Request texts. The [formatRequestQuestion] cases are copied from client-core's
 * `packages/client-core/src/threads/request-question.test.ts`, so the app and the web app
 * word a Request the same.
 */
class RequestTextTest {
    private val decisions = buildCommand("r").decisions

    private fun changeFiles(vararg paths: String) = FileChangeApproval("req-1", "tool-1", FileChangeApproval.Detail(paths.toList()), decisions)
    private fun readFiles(vararg paths: String) = FileReadApproval("req-1", "tool-1", FileReadApproval.Detail(paths.toList()), decisions)

    @Test
    fun `asks to run a command`() {
        assertEquals("Run git push?", formatRequestQuestion(buildCommand("req-1", "git push")))
    }

    @Test
    fun `asks to run only the first non-empty line of a multi-line command`() {
        assertEquals("Run cat <<EOF > notes.txt?", formatRequestQuestion(buildCommand("req-1", "\n  cat <<EOF > notes.txt\nhello\nEOF\n")))
    }

    @Test
    fun `asks to run this command when the harness sent none`() {
        assertEquals("Run this command?", formatRequestQuestion(buildCommand("req-1", " \n")))
    }

    @Test
    fun `names the one file a change touches, or counts several, or asks about files in general`() {
        assertEquals("Change secure.ts?", formatRequestQuestion(changeFiles("src/checkout/secure.ts")))
        assertEquals("Change 3 files?", formatRequestQuestion(changeFiles("a.ts", "b/c.ts", "d.ts")))
        assertEquals("Change files?", formatRequestQuestion(changeFiles()))
    }

    @Test
    fun `names the one file a read touches, or counts several`() {
        assertEquals("Read hosts?", formatRequestQuestion(readFiles("/etc/hosts")))
        assertEquals("Read 2 files?", formatRequestQuestion(readFiles("a.md", "b.md")))
    }

    @Test
    fun `names a directory by its last part, and the root by its whole path`() {
        assertEquals("Read src?", formatRequestQuestion(readFiles("/Users/x/src/")))
        assertEquals("Read src?", formatRequestQuestion(readFiles("src//")))
        assertEquals("Read /?", formatRequestQuestion(readFiles("/")))
    }

    @Test
    fun `asks to run a tool by its name`() {
        assertEquals("Run WebFetch?", formatRequestQuestion(ToolApproval("req-1", "tool-1", ToolApproval.Detail("WebFetch"), decisions)))
    }

    @Test
    fun `uses the first question, in the agent's words`() {
        val request = buildQuestion("req-1", buildAsked("Which region should the rollout start in?"), buildAsked("When?", header = "Time"))
        assertEquals("Which region should the rollout start in?", formatRequestQuestion(request))
    }

    @Test
    fun `reads waiting on you for a kind this build does not know`() {
        val request = UnknownRequest(JsonObject(mapOf("kind" to JsonPrimitive("mcp_elicitation"), "requestId" to JsonPrimitive("req-1"))))
        assertEquals("Waiting on you", formatRequestQuestion(request))
    }

    @Test
    fun `prefixes a subagent's Request with its name, or with a subagent when it has none`() {
        assertEquals("Investigate fixture asks: Run ls?", formatAlertBody(buildCommand("r", "ls", subagentId = "a1", subagentName = "Investigate fixture"), 0))
        assertEquals("A subagent asks: Run ls?", formatAlertBody(buildCommand("r", "ls", subagentId = "a1"), 0))
    }

    @Test
    fun `adds how many more Requests wait on a second line`() {
        assertEquals("Run ls?\n+2 more waiting", formatAlertBody(buildCommand("r", "ls"), 2))
        assertEquals("Run ls?", formatAlertBody(buildCommand("r", "ls"), 0))
    }
}
