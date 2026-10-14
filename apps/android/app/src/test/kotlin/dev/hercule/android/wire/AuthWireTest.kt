package dev.hercule.android.wire

import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

/** Decodes the auth and error bodies captured from a running controller (wire.md A0). */
class AuthWireTest {
    @Test
    fun `encodes the login body`() {
        assertEquals(
            """{"username":"ada","password":"x"}""",
            WireJson.encodeToString(LoginPayload(username = "ada", password = "x")),
        )
    }

    @Test
    fun `decodes the login result`() {
        val result = WireJson.decodeFromString<LoginResult>(
            """{"token":"jkyCt5QiYqAVSZosDUHnZG1OqrAIUSJm1CXtgs3hVM4","expiresAt":"2026-11-11T21:58:28.467Z"}""",
        )
        assertEquals("jkyCt5QiYqAVSZosDUHnZG1OqrAIUSJm1CXtgs3hVM4", result.token)
        assertEquals(Instant.parse("2026-11-11T21:58:28.467Z"), result.expiresAt)
    }

    @Test
    fun `encodes the API key body and decodes the minted key with its id`() {
        assertEquals("""{"name":"Pixel 9"}""", WireJson.encodeToString(ApiKeyCreateInput("Pixel 9")))
        val key = WireJson.decodeFromString<MintedApiKey>(
            """{"id":"01a13220-ec51-757a-8f1b-e22e383103cd","name":"Pixel 9","token":"Ys4_aQgwO5czelQKBT7flJGWEOZ2wLuzmf1AkrJkEk8","createdAt":"2026-10-12T21:59:40.881Z"}""",
        )
        assertEquals("01a13220-ec51-757a-8f1b-e22e383103cd", key.id)
        assertEquals("Ys4_aQgwO5czelQKBT7flJGWEOZ2wLuzmf1AkrJkEk8", key.token)
        assertEquals(Instant.parse("2026-10-12T21:59:40.881Z"), key.createdAt)
    }

    @Test
    fun `decodes the ws ticket`() {
        val ticket = WireJson.decodeFromString<WsTicket>("""{"ticket":"FH9MqADpAgag-iTgyYfe4od61cv6DcSaxIYvFyj5JzQ"}""")
        assertEquals("FH9MqADpAgag-iTgyYfe4od61cv6DcSaxIYvFyj5JzQ", ticket.ticket)
    }

    @Test
    fun `decodes the controller info`() {
        val info = WireJson.decodeFromString<ControllerInfo>(
            """{"id":"01a1321f-93ca-77f0-ba8a-b49a69e03880","publicKey":"MCowBQYDK2VwAyEA6U0Lr7R46jaRidBebshNMBeA0hePpqrD9s+llDJ3jhg=","version":"0.1.0+738cdb2b1","defaultRunnerId":"01a1321f-9470-77f6-ba91-0bc1a99f06ca","localRunnerId":"01a1321f-9470-77f6-ba91-0bc1a99f06ca","textGeneration":{"model":null,"lastFailure":null}}""",
        )
        assertEquals("0.1.0+738cdb2b1", info.version)
        assertEquals("01a1321f-9470-77f6-ba91-0bc1a99f06ca", info.localRunnerId)
    }

    @Test
    fun `decodes an error without details`() {
        val envelope = WireJson.decodeFromString<ApiErrorEnvelope>(
            """{"error":{"code":"unauthenticated","message":"this operation needs a credential"}}""",
        )
        assertEquals(ApiErrorCode.Unauthenticated, envelope.error.code)
        assertEquals("this operation needs a credential", envelope.error.message)
        assertNull(envelope.error.details)
    }

    @Test
    fun `decodes a validation error with its issues`() {
        val envelope = WireJson.decodeFromString<ApiErrorEnvelope>(
            """{"error":{"code":"validation","message":"the request body is not valid","details":{"issues":[{"path":["bogus"],"message":"This field is not known here. Correct its name, or remove it."}]}}}""",
        )
        assertEquals(ApiErrorCode.Validation, envelope.error.code)
        val issue = envelope.error.details!!["issues"]!!.jsonArray.single().jsonObject
        assertEquals(JsonArray(listOf(JsonPrimitive("bogus"))), issue["path"])
    }

    @Test
    fun `decodes a forbidden error with its grant`() {
        val envelope = WireJson.decodeFromString<ApiErrorEnvelope>(
            """{"error":{"code":"forbidden","message":"a notification is a message to you, so you cannot create one; a session or a workflow step creates it","details":{"grant":"notification.write"}}}""",
        )
        assertEquals(ApiErrorCode.Forbidden, envelope.error.code)
        assertEquals("notification.write", envelope.error.details!!["grant"]!!.jsonPrimitive.content)
    }

    @Test
    fun `decodes an error code this build does not know`() {
        val envelope = WireJson.decodeFromString<ApiErrorEnvelope>(
            """{"error":{"code":"teapot","message":"short and stout"}}""",
        )
        assertEquals(ApiErrorCode("teapot"), envelope.error.code)
    }
}
