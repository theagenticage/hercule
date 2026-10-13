package dev.hercule.android.wire

import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

/** Decodes the transcript page and every ProviderEvent example of wire.md A2 §2.1 and §2.2. */
class TranscriptWireTest {
    private fun decodeEvent(json: String): ProviderEvent = WireJson.decodeFromString(json)

    @Test
    fun `decodes a transcript page`() {
        val page = WireJson.decodeFromString<Page<TranscriptRow>>(
            """
            {
              "items": [
                { "position": 1, "at": "2026-10-12T08:01:13.002Z", "event": { "_tag": "session.started", "eventId": "e1", "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e", "at": "2026-10-12T08:01:13.002Z" } },
                { "position": 2, "at": "2026-10-12T08:01:13.100Z", "event": { "_tag": "turn.started", "eventId": "e2", "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e", "at": "2026-10-12T08:01:13.100Z", "turnId": "t1", "model": "claude-opus-4-5" } }
              ],
              "nextCursor": "eyJwIjoyfQ"
            }
            """,
        )
        assertEquals(ProviderEvent.SessionStarted, page.items[0].event)
        assertEquals(ProviderEvent.TurnStarted(turnId = "t1", model = "claude-opus-4-5"), page.items[1].event)
        assertEquals(2L, page.items[1].position)
        assertEquals("eyJwIjoyfQ", page.nextCursor)
    }

    @Test
    fun `decodes the session, turn and runtime events`() {
        assertEquals(
            ProviderEvent.SessionExited(reason = ExitReason.IdleUnload),
            decodeEvent("""{ "_tag": "session.exited", "eventId": "e90", "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e", "at": "2026-10-12T09:00:00.000Z", "reason": "idle_unload" }"""),
        )
        assertEquals(
            ProviderEvent.SubagentStarted(subagentId = "agent_a1b2", itemId = "toolu_01Task", description = "Investigate fixture", agentType = "general-purpose"),
            decodeEvent("""{ "_tag": "subagent.started", "subagentId": "agent_a1b2", "itemId": "toolu_01Task", "description": "Investigate fixture", "agentType": "general-purpose" }"""),
        )
        val completed = assertIs<ProviderEvent.TurnCompleted>(
            decodeEvent("""{ "_tag": "turn.completed", "turnId": "t1", "state": "completed", "usage": { "inputTokens": 48211, "outputTokens": 3120 }, "costUsd": 0.41 }"""),
        )
        assertEquals(TurnState.Completed, completed.state)
        assertEquals(0.41, completed.costUsd)
        assertEquals(
            ProviderEvent.TurnCompleted(turnId = "t2", state = TurnState.Failed, error = "Overloaded"),
            decodeEvent("""{ "_tag": "turn.completed", "turnId": "t2", "state": "failed", "error": "Overloaded" }"""),
        )
        assertEquals(
            ProviderEvent.ContentDelta(turnId = "t1", itemId = "msg_01", streamKind = StreamKind.AssistantText, delta = "The upgrade test fails because "),
            decodeEvent("""{ "_tag": "content.delta", "turnId": "t1", "itemId": "msg_01", "streamKind": "assistant_text", "delta": "The upgrade test fails because " }"""),
        )
        assertEquals(
            0.45,
            assertIs<ProviderEvent.SessionUsageUpdated>(
                decodeEvent("""{ "_tag": "session.usage.updated", "usage": { "inputTokens": 50000, "outputTokens": 3500, "costUsd": 0.45 } }"""),
            ).usage!!.costUsd,
        )
        assertNull(
            assertIs<ProviderEvent.SessionUsageUpdated>(
                decodeEvent("""{ "_tag": "session.usage.updated", "usageReport": { "status": "incomplete", "counts": { "inputTokens": 1, "outputTokens": 2 } } }"""),
            ).usage,
        )
        assertEquals(
            ProviderEvent.RuntimeWarning(turnId = "t1", message = "Access mode auto is not supported; running as approval-required."),
            decodeEvent("""{ "_tag": "runtime.warning", "turnId": "t1", "message": "Access mode auto is not supported; running as approval-required." }"""),
        )
        assertEquals(
            ProviderEvent.RuntimeError(turnId = "t1", errorClass = "rate_limit", message = "429 from provider"),
            decodeEvent("""{ "_tag": "runtime.error", "turnId": "t1", "class": "rate_limit", "message": "429 from provider" }"""),
        )
    }

    @Test
    fun `decodes the request events`() {
        val opened = assertIs<ProviderEvent.RequestOpened>(
            decodeEvent("""{ "_tag": "request.opened", "request": { "requestId": "toolu_01AbCdEf", "itemId": "toolu_01AbCdEf", "kind": "command_approval", "detail": { "command": "pnpm test" }, "decisions": ["allow", "allow_always", "deny", "cancel"] } }"""),
        )
        assertEquals("pnpm test", assertIs<CommandApproval>(opened.request).detail.command)
        assertEquals(
            ProviderEvent.RequestResolved(requestId = "toolu_01AbCdEf", decision = ApprovalDecision.Allow),
            decodeEvent("""{ "_tag": "request.resolved", "requestId": "toolu_01AbCdEf", "decision": "allow" }"""),
        )
        assertEquals(
            ProviderEvent.RequestResolved(requestId = "q_7", answers = mapOf("Database" to listOf("Edge build"), "Checks" to listOf("Typecheck", "Lint"))),
            decodeEvent("""{ "_tag": "request.resolved", "requestId": "q_7", "answers": { "Database": "Edge build", "Checks": ["Typecheck", "Lint"] } }"""),
        )
    }

    @Test
    fun `decodes items with their untyped detail`() {
        val user = assertIs<ProviderEvent.ItemStarted>(
            decodeEvent("""{ "_tag": "item.started", "turnId": "t1", "itemId": "u1", "kind": "user_message", "detail": { "text": "Why does the upgrade test fail?", "attachments": [ { "id": "01928f50-aaaa-7bbb-8ccc-ddddeeee0002", "name": "screenshot.png", "mimeType": "image/png", "sizeBytes": 120334 } ] } }"""),
        )
        assertEquals(ItemKind.UserMessage, user.kind)
        assertEquals("Why does the upgrade test fail?", user.detail!!["text"]!!.jsonPrimitive.content)

        val failed = assertIs<ProviderEvent.ItemCompleted>(
            decodeEvent("""{ "_tag": "item.completed", "turnId": "t1", "itemId": "toolu_01Bash", "kind": "command_execution", "status": "failed", "detail": { "content": "FAIL e2e/upgrade.test.ts > migrates providers\nExpected 3, received 2" } }"""),
        )
        assertEquals(ItemStatus.Failed, failed.status)

        val declined = assertIs<ProviderEvent.ItemCompleted>(
            decodeEvent("""{ "_tag": "item.completed", "turnId": "t1", "itemId": "toolu_01Edit", "kind": "file_change", "status": "declined" }"""),
        )
        assertEquals(ItemStatus.Declined, declined.status)
        assertNull(declined.detail)

        val bash = assertIs<ProviderEvent.ItemStarted>(
            decodeEvent("""{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Bash", "kind": "command_execution", "detail": { "name": "Bash", "input": { "command": "pnpm test e2e/upgrade.test.ts", "description": "Run the upgrade test" } } }"""),
        )
        assertEquals("pnpm test e2e/upgrade.test.ts", bash.detail!!["input"]!!.jsonObject["command"]!!.jsonPrimitive.content)

        val examples = listOf(
            """{ "_tag": "item.started", "turnId": "t1", "itemId": "msg_01", "kind": "assistant_message" }""" to ItemKind.AssistantMessage,
            """{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Edit", "kind": "file_change", "detail": { "name": "Edit", "input": { "file_path": "/repo/e2e/upgrade.test.ts", "old_string": "3", "new_string": "2" } } }""" to ItemKind.FileChange,
            """{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Read", "kind": "file_read", "detail": { "name": "Read", "input": { "file_path": "/repo/e2e/upgrade.test.ts" }, "path": "/repo/e2e/upgrade.test.ts" } }""" to ItemKind.FileRead,
            """{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Grep", "kind": "file_search", "detail": { "name": "Grep", "input": { "pattern": "MIGRATIONS" }, "pattern": "MIGRATIONS" } }""" to ItemKind.FileSearch,
            """{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Mcp", "kind": "tool_call", "detail": { "name": "mcp__github__create_pull_request", "input": { "title": "Fix upgrade test" }, "kind": "mcp" } }""" to ItemKind.ToolCall,
            """{ "_tag": "item.started", "turnId": "t1", "itemId": "ws_1", "kind": "web_search", "detail": { "description": "effect schema optionalKey" } }""" to ItemKind.WebSearch,
            """{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Task", "kind": "subagent", "detail": { "name": "Task", "input": { "description": "Investigate fixture", "prompt": "Look at e2e/upgrade.test.ts", "subagent_type": "general-purpose" } } }""" to ItemKind.Subagent,
            """{ "_tag": "item.started", "turnId": "t1", "itemId": "plan_1", "kind": "plan" }""" to ItemKind.Plan,
            """{ "_tag": "item.completed", "turnId": "t1", "itemId": "cc_1", "kind": "context_compaction", "status": "completed", "detail": { "trigger": "auto", "preTokens": 180000, "postTokens": 22000 } }""" to ItemKind.ContextCompaction,
            """{ "_tag": "item.completed", "turnId": "t1", "itemId": "err_1", "kind": "error", "status": "failed", "detail": { "class": "api_error" } }""" to ItemKind.Error,
            """{ "_tag": "item.started", "turnId": "t1", "itemId": "x_1", "kind": "unknown" }""" to ItemKind.Unknown,
            """{ "_tag": "item.started", "turnId": "t1", "itemId": "h_1", "kind": "hologram" }""" to ItemKind("hologram"),
        )
        for ((json, kind) in examples) {
            val event = decodeEvent(json)
            val decodedKind = when (event) {
                is ProviderEvent.ItemStarted -> event.kind
                is ProviderEvent.ItemCompleted -> event.kind
                else -> null
            }
            assertEquals(kind, decodedKind, json)
        }
    }

    @Test
    fun `decodes an event tag this build does not know`() {
        val unknown = assertIs<ProviderEvent.Unknown>(
            decodeEvent("""{ "_tag": "item.updated", "eventId": "e5", "sessionId": "s", "at": "2026-10-12T08:01:13.100Z", "turnId": "t1", "itemId": "i1" }"""),
        )
        assertEquals("item.updated", unknown.tag)
        assertEquals("i1", unknown.json["itemId"]!!.jsonPrimitive.content)
    }
}
