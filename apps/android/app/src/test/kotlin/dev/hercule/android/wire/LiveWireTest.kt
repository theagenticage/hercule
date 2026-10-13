package dev.hercule.android.wire

import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/** Decodes the live topic payloads and encodes the hello and subscribe payloads (wire.md B). */
class LiveWireTest {
    @Test
    fun `decodes the first invalidate of a session subscription`() {
        val invalidate = WireJson.decodeFromString<Invalidate>("""{"ids":[],"kind":"updated","conversationIds":{}}""")
        assertTrue(invalidate.ids.isEmpty())
        assertEquals(InvalidateKind.Updated, invalidate.kind)
        assertEquals(emptyMap(), invalidate.conversationIds)
    }

    @Test
    fun `decodes invalidates with and without conversation ids`() {
        val runner = WireJson.decodeFromString<Invalidate>("""{"ids":["01a1321f-9470-77f6-ba91-0bc1a99f06ca"],"kind":"updated"}""")
        assertNull(runner.conversationIds)

        val session = WireJson.decodeFromString<Invalidate>(
            """{"ids":["s1","s2"],"kind":"created","conversationIds":{"s1":"c1","s2":null}}""",
        )
        assertEquals(mapOf("s1" to "c1", "s2" to null), session.conversationIds)
        assertEquals(InvalidateKind.Created, session.kind)

        val unknown = WireJson.decodeFromString<Invalidate>("""{"ids":["x"],"kind":"archived"}""")
        assertEquals(InvalidateKind("archived"), unknown.kind)
    }

    @Test
    fun `decodes a stream delta into transcript rows`() {
        val delta = WireJson.decodeFromString<Delta>(
            """{"cursor":"eyJwIjo0Mn0","items":[{"position":42,"at":"2026-10-12T08:14:55.910Z","event":{"_tag":"content.delta","turnId":"t1","itemId":"msg_01","streamKind":"assistant_text","delta":"The upgrade test fails because the fixture"}}]}""",
        )
        assertEquals("eyJwIjo0Mn0", delta.cursor)
        val row = WireJson.decodeFromJsonElement(TranscriptRow.serializer(), delta.items.single())
        assertEquals(42L, row.position)
        assertIs<ProviderEvent.ContentDelta>(row.event)
    }

    @Test
    fun `decodes an empty stream delta`() {
        val delta = WireJson.decodeFromString<Delta>("""{"cursor":"eyJwIjo0Mn0","items":[]}""")
        assertTrue(delta.items.isEmpty())
    }

    @Test
    fun `decodes a tap delta into tap items`() {
        val delta = WireJson.decodeFromString<Delta>(
            """{"cursor":null,"items":[{"turnId":"t1","itemId":"msg_01","streamKind":"assistant_text","delta":"The "},{"turnId":"t1","itemId":"rs_01","streamKind":"reasoning_text","delta":"Check","subagentId":"agent_a1b2"}]}""",
        )
        assertNull(delta.cursor)
        val items = delta.items.map { WireJson.decodeFromJsonElement(TapItem.serializer(), it) }
        assertEquals(TapItem("t1", "msg_01", StreamKind.AssistantText, "The "), items[0])
        assertEquals(StreamKind.ReasoningText, items[1].streamKind)
        assertEquals("agent_a1b2", items[1].subagentId)
    }

    @Test
    fun `decodes the hello result`() {
        val result = WireJson.decodeFromString<LiveHelloResult>("""{"v":1,"serverVersion":"0.1.0+738cdb2b1"}""")
        assertEquals("0.1.0+738cdb2b1", result.serverVersion)
    }

    @Test
    fun `encodes the hello and subscribe payloads`() {
        assertEquals(
            """{"v":1,"ticket":"FH9MqADpAgag-iTgyYfe4od61cv6DcSaxIYvFyj5JzQ"}""",
            WireJson.encodeToString(LiveHello(1, "FH9MqADpAgag-iTgyYfe4od61cv6DcSaxIYvFyj5JzQ")),
        )
        assertEquals("""{"topic":"session"}""", WireJson.encodeToString(LiveSubscribe("session")))
        assertEquals(
            """{"topic":"session:s1:stream","cursor":"eyJwIjo0Mn0"}""",
            WireJson.encodeToString(LiveSubscribe("session:s1:stream", "eyJwIjo0Mn0")),
        )
    }
}
