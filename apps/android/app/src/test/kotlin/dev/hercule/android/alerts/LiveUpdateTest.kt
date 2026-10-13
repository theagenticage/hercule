package dev.hercule.android.alerts

import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.SessionStatus
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test

/** Tests the followed thread's Live Update: its track, its text and its buttons. */
class LiveUpdateTest {
    private val working = buildSession("s1", status = SessionStatus.Busy)

    @Test
    fun `counts the completed steps of the current turn only`() {
        val transcript = buildTranscript(
            turnStarted(),
            itemCompleted("old", ItemKind.CommandExecution),
            turnStarted(),
            itemStarted("a", ItemKind.FileRead),
            itemCompleted("a", ItemKind.FileRead),
            itemStarted("b", ItemKind.CommandExecution, mapOf("command" to "pnpm test cart")),
        )
        val update = buildLiveUpdate(working, transcript, alert = false)

        assertEquals(1, update.doneSteps)
        assertEquals("pnpm test cart", update.text)
    }

    @Test
    fun `leaves out the agent's messages, its reasoning and every subagent event`() {
        val transcript = buildTranscript(
            turnStarted(),
            itemCompleted("a", ItemKind.FileRead, mapOf("path" to "src/cart.ts")),
            itemCompleted("m", ItemKind.AssistantMessage),
            itemCompleted("t", ItemKind.Reasoning),
            turnStarted(subagentId = "agent-1"),
            itemCompleted("x", ItemKind.CommandExecution, subagentId = "agent-1"),
        )
        val update = buildLiveUpdate(working, transcript, alert = false)

        assertEquals(1, update.doneSteps)
        assertEquals("Read cart.ts", update.text)
    }

    @Test
    fun `shows at most three done segments`() {
        val steps = (1..5).map { itemCompleted("i$it", ItemKind.FileRead) }
        val update = buildLiveUpdate(working, buildTranscript(turnStarted(), *steps.toTypedArray()), alert = false)

        assertEquals(MAX_DONE_STEPS, update.doneSteps)
    }

    @Test
    fun `reads working with no buttons while no step and no Request is there`() {
        val update = buildLiveUpdate(working, emptyList(), alert = false)

        assertEquals("Working", update.text)
        assertEquals("Working", update.shortText)
        assertFalse(update.isWaiting)
        assertNull(update.actions)
    }

    @Test
    fun `shows the newest Request with its buttons while waiting`() {
        val waiting = buildSession("s1", openRequests = listOf(buildCommand("r1", "ls"), buildCommand("r2", "git push")))
        val update = buildLiveUpdate(waiting, emptyList(), alert = true)

        assertTrue(update.isWaiting)
        assertEquals("Waiting on you · Run git push?", update.text)
        assertEquals("Run?", update.shortText)
        assertEquals(decideAlertActions("s1", waiting.openRequests.last()), update.actions)
        assertTrue(update.alert)
    }

    @Test
    fun `asks a short question in the Now Bar for each kind of Request`() {
        assertEquals("Run?", formatShortText(buildCommand("r")))
        assertEquals("Answer?", formatShortText(buildQuestion("r")))
    }

    @Test
    fun `describes each kind of step briefly`() {
        assertEquals("pnpm test", describeStep(ItemKind.CommandExecution, buildTranscriptDetail("command" to "\n pnpm test\nmore")))
        assertEquals("Edit checkout.ts", describeStep(ItemKind.FileChange, buildTranscriptDetail("path" to "src/checkout.ts")))
        assertEquals("Read hosts", describeStep(ItemKind.FileRead, buildTranscriptDetail("file_path" to "/etc/hosts")))
        assertEquals("Search TODO", describeStep(ItemKind.FileSearch, buildTranscriptDetail("pattern" to "TODO")))
        assertEquals("Search the web", describeStep(ItemKind.WebSearch, null))
        assertEquals("WebFetch", describeStep(ItemKind.ToolCall, buildTranscriptDetail("name" to "WebFetch")))
        assertEquals("Working", describeStep(ItemKind.FileChange, null))
        assertEquals("Working", describeStep(ItemKind.CommandExecution, JsonArray(listOf(JsonPrimitive("pnpm test")))))
    }

    private fun buildTranscriptDetail(vararg entries: Pair<String, String>) =
        itemStarted("i", ItemKind.Unknown, entries.toMap()).detail
}
