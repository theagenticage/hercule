package dev.hercule.android.controller

import dev.hercule.android.wire.ApiErrorCode
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Before
import org.junit.Test

/** Tests [ControllerApi] against a mock controller: paths, bodies, auth, pages and errors. */
class ControllerApiTest {
    private val server = MockWebServer()
    private val httpClient = OkHttpClient()

    @Before
    fun startServer() = server.start()

    @After
    fun stopServer() = server.close()

    private fun buildApi(token: String? = "key-1") = ControllerApi(server.url("/"), token, httpClient)

    private fun enqueueJson(body: String, code: Int = 200) =
        server.enqueue(MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build())

    private fun takeRequest(): RecordedRequest = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS))

    @Test
    fun `login posts the username and password without a bearer token`() = runTest {
        enqueueJson("""{"token":"login-token","expiresAt":"2026-10-14T09:00:00Z"}""")

        val result = buildApi(token = null).login("ada", "secret")

        assertEquals("login-token", result.token)
        val request = takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/v1/auth/login", request.target)
        assertNull(request.headers["Authorization"])
        assertEquals("""{"username":"ada","password":"secret"}""", request.body?.utf8())
    }

    @Test
    fun `createWsTicket posts an empty object with the bearer token`() = runTest {
        enqueueJson("""{"ticket":"t-1"}""")

        assertEquals("t-1", buildApi().createWsTicket().ticket)

        val request = takeRequest()
        assertEquals("/api/v1/auth/ws-ticket", request.target)
        assertEquals("Bearer key-1", request.headers["Authorization"])
        assertEquals("{}", request.body?.utf8())
    }

    @Test
    fun `listThreadSessions reads every page, sending the cursor with the same filters`() = runTest {
        enqueueJson("""{"items":[${buildSessionJson("s1")}],"nextCursor":"c1"}""")
        enqueueJson("""{"items":[${buildSessionJson("s2")}]}""")

        val sessions = buildApi().listThreadSessions()

        assertEquals(listOf("s1", "s2"), sessions.map { it.id })
        assertEquals("/api/v1/sessions?thread=true&limit=500", takeRequest().target)
        assertEquals("/api/v1/sessions?thread=true&limit=500&cursor=c1", takeRequest().target)
    }

    @Test
    fun `readCurrentConversationSession asks for the newest session of the conversation`() = runTest {
        enqueueJson("""{"items":[]}""")

        assertNull(buildApi().readCurrentConversationSession("conv 1"))

        val url = takeRequest().url
        assertEquals("/api/v1/sessions", url.encodedPath)
        assertEquals("conv 1", url.queryParameter("conversationId"))
        assertEquals(listOf("createdAt:desc"), url.queryParameterValues("sort"))
        assertEquals("1", url.queryParameter("limit"))
    }

    @Test
    fun `revokeApiKey deletes the key by id`() = runTest {
        enqueueJson("{}")

        buildApi().revokeApiKey("k1")

        val request = takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/v1/api-keys/k1", request.target)
    }

    @Test
    fun `an error envelope fails with its code and message`() = runTest {
        enqueueJson("""{"error":{"code":"invalid_state","message":"the session has exited"}}""", code = 409)

        val failure = assertFailsWith<ControllerApiException> { buildApi().readSession("s1") }

        assertEquals(ApiErrorCode.InvalidState, failure.error.code)
        assertEquals("the session has exited", failure.error.message)
        assertEquals(409, failure.httpStatus)
    }

    @Test
    fun `a reply that is not an error envelope fails as internal, naming the status`() = runTest {
        server.enqueue(MockResponse.Builder().code(413).body("<html>Request Entity Too Large</html>").build())

        val failure = assertFailsWith<ControllerApiException> { buildApi().readSession("s1") }

        assertEquals(ApiErrorCode.Internal, failure.error.code)
        assertEquals("The controller answered HTTP 413 without an error body.", failure.error.message)
    }
}

/** Builds the JSON of a thread session with the id [id], as `session.query` lists it. */
internal fun buildSessionJson(id: String, conversationId: String? = null): String = """
    {"id":"$id","title":"Thread $id","status":"idle","resumable":true,"resumeHeld":false,
     "permissionProfileId":"p1","agentId":null,"conversationId":${conversationId?.let { "\"$it\"" } ?: "null"},
     "runId":null,"stepId":null,"instanceId":"i1","runnerId":"r1","workspaceId":null,"projectId":null,
     "requestedAccessMode":"auto","accessMode":"auto","nativeSessionId":null,
     "modelSelection":{"model":"m","options":{}},"parentSessionId":null,"openRequests":[],
     "openPermissionRequests":[],"toolCalls":0,"createdAt":"2026-10-13T09:00:00Z","startedAt":null,
     "exitedAt":null,"lastActivityAt":"2026-10-13T09:00:00Z"}
""".trimIndent()
