package dev.hercule.android.wire

import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test

/** Decodes the assistant, conversation and message bodies, and encodes conversation.send (wire.md A0, A1). */
class ConversationWireTest {
    @Test
    fun `decodes an assistants page with and without a model`() {
        val page = WireJson.decodeFromString<Page<Assistant>>(
            """
            {"items":[
              {"id":"01a1321f-9530-7000-8000-0000000000a1","name":"Hercule","instanceId":"01a1321f-9470-77f6-ba91-0bc1a99f0001","permissionProfileId":"01a1321f-93ca-77f0-ba8a-b49a69e00001","accessMode":"auto","model":null,"systemPrompt":"","heartbeat":null,"createdAt":"2026-10-12T21:58:20.001Z","updatedAt":"2026-10-12T21:58:20.001Z","reply":"turn-end","mainConversationId":"01a1321f-9530-7000-8000-0000000000c1"},
              {"id":"01a1321f-9530-7000-8000-0000000000a2","name":"Ada","instanceId":"01a1321f-9470-77f6-ba91-0bc1a99f0001","permissionProfileId":"01a1321f-93ca-77f0-ba8a-b49a69e00001","accessMode":"approval-required","model":{"model":"claude-opus-4-5","options":{"effort":"high"}},"createdAt":"2026-10-12T22:00:00.000Z","updatedAt":"2026-10-12T22:05:00.000Z","reply":"segments","mainConversationId":"01a1321f-9530-7000-8000-0000000000c2"}
            ],"nextCursor":null}
            """,
        )
        val (hercule, ada) = page.items
        assertNull(hercule.model)
        assertEquals(AssistantReply.TurnEnd, hercule.reply)
        assertEquals(AccessMode.Auto, hercule.accessMode)
        assertEquals(JsonPrimitive("high"), ada.model!!.options["effort"])
        assertEquals(AssistantReply.Segments, ada.reply)
        assertNull(page.nextCursor)
    }

    @Test
    fun `decodes an assistant from a controller that no longer sends instanceId`() {
        val assistant = WireJson.decodeFromString<Assistant>(
            """{"id":"01a1321f-9530-7000-8000-0000000000a1","name":"Hercule","providerAccountId":"01a1321f-9470-77f6-ba91-0bc1a99f0001","harnessId":null,"permissionProfileId":"01a1321f-93ca-77f0-ba8a-b49a69e00001","accessMode":"auto","model":null,"systemPrompt":"","heartbeat":null,"createdAt":"2026-10-12T21:58:20.001Z","updatedAt":"2026-10-12T21:58:20.001Z","reply":"turn-end","mainConversationId":"01a1321f-9530-7000-8000-0000000000c1"}""",
        )

        assertEquals("Hercule", assistant.name)
    }

    @Test
    fun `decodes a conversations page`() {
        val page = WireJson.decodeFromString<Page<Conversation>>(
            """{"items":[{"id":"01a1321f-9530-7000-8000-0000000000c1","assistantId":"01a1321f-9530-7000-8000-0000000000a1","channel":"web","containerKey":null,"createdAt":"2026-10-12T21:58:20.001Z"}],"nextCursor":null}""",
        )
        val conversation = page.items.single()
        assertEquals(ConversationChannel.Web, conversation.channel)
        assertNull(conversation.containerKey)
    }

    @Test
    fun `decodes a messages page with an owner, an assistant and a notice message`() {
        val page = WireJson.decodeFromString<Page<ConversationMessage>>(
            """
            {"items":[
              {"id":"m1","conversationId":"c1","containerKey":null,"position":1,"senderRole":"owner","senderLabel":"You","text":"Open the PR for the flake fix","sessionId":null,"turnId":null,"itemId":null,"actor":"user","createdAt":"2026-10-12T22:10:00.000Z"},
              {"id":"m2","conversationId":"c1","containerKey":null,"position":2,"senderRole":"assistant","senderLabel":"Ada","text":"Opened #412.","sessionId":"s1","turnId":"t1","itemId":"msg_01","actor":"session:s1","createdAt":"2026-10-12T22:10:30.000Z"},
              {"id":"m3","conversationId":"c1","containerKey":null,"position":3,"senderRole":"notice","senderLabel":"Notice","text":"Ada's runner went offline.","sessionId":null,"turnId":null,"itemId":null,"actor":"user","createdAt":"2026-10-12T22:11:00.000Z"},
              {"id":"m4","conversationId":"c1","containerKey":null,"position":4,"senderRole":"bystander","senderLabel":"?","text":"","sessionId":null,"turnId":null,"itemId":null,"actor":"user","createdAt":"2026-10-12T22:12:00.000Z"}
            ],"nextCursor":"eyJwIjo0fQ"}
            """,
        )
        assertEquals(
            listOf(ConversationSenderRole.Owner, ConversationSenderRole.Assistant, ConversationSenderRole.Notice, ConversationSenderRole("bystander")),
            page.items.map { it.senderRole },
        )
        assertEquals("session:s1", page.items[1].actor)
        assertEquals(2L, page.items[1].position)
        assertEquals("eyJwIjo0fQ", page.nextCursor)
    }

    @Test
    fun `encodes the conversation send body`() {
        assertEquals(
            """{"text":"Open the PR for the flake fix"}""",
            WireJson.encodeToString(ConversationSendInput("Open the PR for the flake fix")),
        )
    }
}
