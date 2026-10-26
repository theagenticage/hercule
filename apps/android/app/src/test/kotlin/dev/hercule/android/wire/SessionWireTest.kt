package dev.hercule.android.wire

import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Instant
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test

/** Decodes session records and encodes the session request bodies (wire.md A2 §1, §2). */
class SessionWireTest {
    @Test
    fun `decodes a busy Thread with an approval and a question open`() {
        val session = WireJson.decodeFromString<Session>(BUSY_THREAD)

        assertEquals(SessionStatus.Busy, session.status)
        assertNull(session.agentId)
        assertEquals(AccessMode.ApprovalRequired, session.accessMode)
        assertEquals("claude-opus-4-5", session.modelSelection.model)
        assertEquals(JsonPrimitive(false), session.modelSelection.options["fast"])
        assertEquals(48211L, session.usage!!.inputTokens)
        assertEquals(17, session.toolCalls)
        assertEquals(Instant.parse("2026-10-12T08:14:55.910Z"), session.lastActivityAt)
        assertNull(session.exitedAt)

        val approval = assertIs<CommandApproval>(session.openRequests[0])
        assertEquals("toolu_01AbCdEf", approval.requestId)
        assertEquals("pnpm test e2e/upgrade.test.ts", approval.detail.command)
        assertEquals(
            listOf(ApprovalDecision.Allow, ApprovalDecision.AllowAlways, ApprovalDecision.Deny, ApprovalDecision.Cancel),
            approval.decisions,
        )
        assertNull(approval.subagentId)

        val question = assertIs<QuestionRequest>(session.openRequests[1])
        assertEquals("agent_a1b2", question.subagentId)
        assertEquals("Investigate fixture", question.subagentName)
        val asked = question.detail.questions.single()
        assertEquals("Database", asked.header)
        assertEquals(listOf("Edge build", "Fresh"), asked.options.map { it.label })
        assertEquals(false, asked.multiSelect)
        assertNull(asked.secret)
    }

    @Test
    fun `decodes the other request kinds, a secret question and an unknown kind`() {
        val requests = WireJson.decodeFromString<List<SessionRequest>>(
            """
            [
              {"requestId":"r1","itemId":"i1","kind":"file_change_approval","detail":{"paths":["/a.ts","/b.ts"]},"decisions":["allow","deny"]},
              {"requestId":"r2","itemId":"i2","kind":"file_read_approval","detail":{"paths":["/c.ts"]},"decisions":["allow"]},
              {"requestId":"r3","itemId":"i3","kind":"tool_approval","detail":{"toolName":"mcp__github__create_pull_request"},"decisions":["allow","allow_always","deny"]},
              {"requestId":"r4","itemId":"i4","kind":"question","detail":{"questions":[
                {"question":"Paste the token","header":"Token","options":[],"multiSelect":false,"secret":true},
                {"question":"Which checks?","header":"Checks","options":[{"label":"Typecheck","description":"bun check"},{"label":"Lint","description":"oxlint"}],"multiSelect":true}
              ]}},
              {"requestId":"r5","itemId":"i5","kind":"voice_approval","detail":{"clip":"x"},"decisions":["allow"]}
            ]
            """,
        )
        assertEquals(listOf("/a.ts", "/b.ts"), assertIs<FileChangeApproval>(requests[0]).detail.paths)
        assertEquals(listOf("/c.ts"), assertIs<FileReadApproval>(requests[1]).detail.paths)
        assertEquals("mcp__github__create_pull_request", assertIs<ToolApproval>(requests[2]).detail.toolName)
        val questions = assertIs<QuestionRequest>(requests[3]).detail.questions
        assertEquals(true, questions[0].secret)
        assertTrue(questions[0].options.isEmpty())
        assertEquals(true, questions[1].multiSelect)
        val unknown = assertIs<UnknownRequest>(requests[4])
        assertEquals("voice_approval", unknown.kind)
        assertEquals("r5", unknown.requestId)
    }

    @Test
    fun `decodes an async question whose options have no description`() {
        val request = WireJson.decodeFromString<SessionRequest>(
            """
            {"requestId":"r6","itemId":"i6","kind":"question","async":true,"detail":{"questions":[
              {"question":"Ship it?","header":"Ship","options":[{"label":"Yes"},{"label":"No"}],"multiSelect":false}
            ]}}
            """,
        )
        val asked = assertIs<QuestionRequest>(request)
        assertEquals(true, asked.async)
        assertEquals(listOf("Yes", "No"), asked.detail.questions.single().options.map { it.label })
        assertEquals(listOf(null, null), asked.detail.questions.single().options.map { it.description })
    }

    @Test
    fun `decodes a status and an access mode this build does not know`() {
        val session = WireJson.decodeFromString<Session>(
            BUSY_THREAD.replace("\"status\": \"busy\"", "\"status\": \"paused\"")
                .replace("\"accessMode\": \"approval-required\"", "\"accessMode\": \"read-only\""),
        )
        assertEquals(SessionStatus("paused"), session.status)
        assertEquals(AccessMode("read-only"), session.accessMode)
    }

    @Test
    fun `decodes a Thread marked Done and reopened, and leaves both null when absent`() {
        val session = WireJson.decodeFromString<Session>(
            BUSY_THREAD.replace(
                "\"exitedAt\": null,",
                "\"exitedAt\": null, \"done\": { \"at\": \"2026-10-12T09:00:00.000Z\", \"by\": \"user\" }, \"reopenedAt\": \"2026-10-12T08:30:00.000Z\",",
            ),
        )
        assertEquals(ThreadDone(Instant.parse("2026-10-12T09:00:00.000Z"), "user"), session.done)
        assertEquals(Instant.parse("2026-10-12T08:30:00.000Z"), session.reopenedAt)

        val plain = WireJson.decodeFromString<Session>(BUSY_THREAD)
        assertNull(plain.done)
        assertNull(plain.reopenedAt)
    }

    @Test
    fun `decodes a permission request`() {
        val request = WireJson.decodeFromString<PermissionRequest>(
            """
            {
              "id": "01928f40-1111-7aaa-8bbb-ccccdddd0001",
              "grant": "connection.write",
              "reason": "I need to create a GitHub connection to open the PR.",
              "operation": { "op": "connection.create", "input": { "type": "github", "name": "work" } },
              "createdAt": "2026-10-12T08:20:00.000Z"
            }
            """,
        )
        assertEquals("connection.write", request.grant)
    }

    @Test
    fun `encodes a session input with only the fields that are set`() {
        assertEquals("""{"text":"hi"}""", WireJson.encodeToString(SessionInputPayload(text = "hi")))
        assertEquals(
            """{"text":"Also check the fixture rows.","steer":true}""",
            WireJson.encodeToString(SessionInputPayload(text = "Also check the fixture rows.", steer = true)),
        )
    }

    @Test
    fun `decodes a session input outcome`() {
        val outcome = WireJson.decodeFromString<SessionInputOutcome>(
            """{ "inputId": "01928f60-0000-7aaa-8bbb-000000000001", "result": "steered" }""",
        )
        assertEquals(SessionInputResult.Steered, outcome.result)
    }

    @Test
    fun `encodes an approval decision`() {
        assertEquals(
            """{"requestId":"toolu_01AbCdEf","decision":"allow_always"}""",
            WireJson.encodeToString(SessionRespondToApprovalRequestInput("toolu_01AbCdEf", ApprovalDecision.AllowAlways)),
        )
    }

    @Test
    fun `encodes question answers, one answer as a string and several as an array`() {
        val body = SessionRespondToQuestionInput(
            requestId = "q_7",
            answers = mapOf(
                "Database" to listOf("Edge build"),
                "Checks" to listOf("Typecheck", "Lint"),
                "Notes" to listOf("Use the October edge build, not September's."),
            ),
        )
        assertEquals(
            """{"requestId":"q_7","answers":{"Database":"Edge build","Checks":["Typecheck","Lint"],"Notes":"Use the October edge build, not September's."}}""",
            WireJson.encodeToString(body),
        )
    }

    private companion object {
        /** The example Session of wire.md A2 §1.1, with its placeholder ids as written there. */
        const val BUSY_THREAD = """
            {
              "id": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e",
              "title": "Fix flaky upgrade test",
              "status": "busy",
              "resumable": false,
              "resumeHeld": false,
              "permissionProfileId": "01928f00-0000-7000-8000-000000000001",
              "agentId": null,
              "conversationId": null,
              "runId": null,
              "stepId": null,
              "instanceId": "01928f00-0000-7000-8000-0000000000c1",
              "runnerId": "01928f00-0000-7000-8000-0000000000r1",
              "workspaceId": "01928f3a-7c00-7000-8000-00000000ws01",
              "projectId": "01928f00-0000-7000-8000-0000000000p1",
              "requestedAccessMode": "approval-required",
              "accessMode": "approval-required",
              "nativeSessionId": "5f0c1e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
              "modelSelection": { "model": "claude-opus-4-5", "options": { "effort": "high", "fast": false } },
              "parentSessionId": null,
              "openRequests": [
                {
                  "requestId": "toolu_01AbCdEf",
                  "itemId": "toolu_01AbCdEf",
                  "kind": "command_approval",
                  "detail": { "command": "pnpm test e2e/upgrade.test.ts" },
                  "decisions": ["allow", "allow_always", "deny", "cancel"]
                },
                {
                  "requestId": "q_7",
                  "itemId": "toolu_01XyZ",
                  "kind": "question",
                  "detail": {
                    "questions": [
                      {
                        "question": "Which database should the fixture use?",
                        "header": "Database",
                        "options": [
                          { "label": "Edge build", "description": "Fill it with the previous edge binary" },
                          { "label": "Fresh", "description": "Start from an empty database" }
                        ],
                        "multiSelect": false
                      }
                    ]
                  },
                  "subagentId": "agent_a1b2",
                  "subagentName": "Investigate fixture"
                }
              ],
              "openPermissionRequests": [],
              "usage": { "inputTokens": 48211, "outputTokens": 3120, "cacheReadTokens": 40100, "cacheWriteTokens": 2050, "costUsd": 0.4123 },
              "usageReport": { "status": "complete", "counts": { "inputTokens": 48211, "outputTokens": 3120 } },
              "toolCalls": 17,
              "createdAt": "2026-10-12T08:01:12.345Z",
              "startedAt": "2026-10-12T08:01:13.002Z",
              "exitedAt": null,
              "lastActivityAt": "2026-10-12T08:14:55.910Z",
              "unenforced": []
            }
        """
    }
}
