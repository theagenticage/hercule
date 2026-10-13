package dev.hercule.android.controller

import dev.hercule.android.wire.ApiError
import dev.hercule.android.wire.ApiErrorCode
import dev.hercule.android.wire.ApiErrorEnvelope
import dev.hercule.android.wire.ApiKeyCreateInput
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.ConversationSendInput
import dev.hercule.android.wire.LoginPayload
import dev.hercule.android.wire.LoginResult
import dev.hercule.android.wire.MintedApiKey
import dev.hercule.android.wire.Page
import dev.hercule.android.wire.Project
import dev.hercule.android.wire.QuestionAnswers
import dev.hercule.android.wire.Runner
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionInputOutcome
import dev.hercule.android.wire.SessionInputPayload
import dev.hercule.android.wire.SessionRespondToApprovalRequestInput
import dev.hercule.android.wire.SessionRespondToQuestionInput
import dev.hercule.android.wire.TranscriptRow
import dev.hercule.android.wire.WireJson
import dev.hercule.android.wire.WsTicket
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Thrown when the controller answers a request with an error. [error] is the decoded error
 * envelope, so callers switch on [ApiError.code]. A failure to reach the controller at all is
 * an [IOException] instead, never this type.
 */
class ControllerApiException(val error: ApiError, val httpStatus: Int) :
    Exception("${error.code.wire}: ${error.message}")

/**
 * Calls the controller's public HTTP API, one suspend function per operation the app uses.
 *
 * Every function fails with [ControllerApiException] when the controller answers with an
 * error, and with [IOException] when the request does not reach it or the reply is cut off.
 *
 * [origin] is the controller's address, such as `http://mac.tailnet.ts.net:4961`. Every
 * request carries [bearerToken] as `Authorization: Bearer`; it is null only for
 * [login], which is what produces a token.
 */
class ControllerApi(
    val origin: HttpUrl,
    private val bearerToken: String?,
    private val httpClient: OkHttpClient,
) {
    // `session.input` waits up to 130 s for the agent's runner to accept the input, longer
    // than OkHttp's default 10 s read timeout.
    private val sessionInputClient: OkHttpClient by lazy {
        httpClient.newBuilder().readTimeout(SESSION_INPUT_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS).build()
    }

    /** Signs in with a username and password (`auth.login`) and returns the login token. */
    suspend fun login(username: String, password: String): LoginResult =
        send("POST", buildUrl("auth/login"), encode(LoginPayload(username, password)), LoginResult.serializer())

    /** Creates an API key named [name] (`apiKey.create`) and returns it with its secret. */
    suspend fun createApiKey(name: String): MintedApiKey =
        send("POST", buildUrl("api-keys"), encode(ApiKeyCreateInput(name)), MintedApiKey.serializer())

    /** Revokes the API key [apiKeyId] (`apiKey.revoke`). */
    suspend fun revokeApiKey(apiKeyId: String) {
        send("DELETE", buildUrl("api-keys", apiKeyId), null, JsonObject.serializer())
    }

    /** Creates a single-use ticket for the live socket's `hello` (`auth.wsTicket`). */
    suspend fun createWsTicket(): WsTicket =
        send("POST", buildUrl("auth/ws-ticket"), EMPTY_OBJECT, WsTicket.serializer())

    /** Lists every thread (`session.query` with `thread=true`), reading every page. */
    suspend fun listThreadSessions(): List<Session> = readAllPages(Session.serializer()) { cursor ->
        buildUrl("sessions") {
            addQueryParameter("thread", "true")
            addQueryParameter("limit", PAGE_LIMIT)
            if (cursor != null) addQueryParameter("cursor", cursor)
        }
    }

    /**
     * Returns the newest session of the conversation [conversationId] (`session.query`), which
     * is the assistant's current session when the conversation is its main one, or null when
     * the conversation has no session yet.
     */
    suspend fun readCurrentConversationSession(conversationId: String): Session? {
        val url = buildUrl("sessions") {
            addQueryParameter("conversationId", conversationId)
            addQueryParameter("sort", "createdAt:desc")
            addQueryParameter("limit", "1")
        }
        return send("GET", url, null, Page.serializer(Session.serializer())).items.firstOrNull()
    }

    /** Reads one session (`session.read`). */
    suspend fun readSession(sessionId: String): Session =
        send("GET", buildUrl("sessions", sessionId), null, Session.serializer())

    /** Reads a session's whole transcript (`transcript.read`), oldest row first, every page. */
    suspend fun readTranscript(sessionId: String): List<TranscriptRow> =
        readAllPages(TranscriptRow.serializer()) { cursor ->
            buildUrl("sessions", sessionId, "transcript") {
                addQueryParameter("limit", PAGE_LIMIT)
                if (cursor != null) addQueryParameter("cursor", cursor)
            }
        }

    /**
     * Sends input to a session (`session.input`). The call can take up to 130 s, because the
     * controller waits for the runner to accept the input.
     */
    suspend fun sendSessionInput(sessionId: String, payload: SessionInputPayload): SessionInputOutcome =
        send(
            "POST",
            buildUrl("sessions", sessionId, "input"),
            encode(payload),
            SessionInputOutcome.serializer(),
            sessionInputClient,
        )

    /** Answers the approval request [requestId] of a session and returns the updated session. */
    suspend fun respondToApprovalRequest(
        sessionId: String,
        requestId: String,
        decision: ApprovalDecision,
    ): Session = send(
        "POST",
        buildUrl("sessions", sessionId, "respond-to-approval-request"),
        encode(SessionRespondToApprovalRequestInput(requestId, decision)),
        Session.serializer(),
    )

    /** Answers the question [requestId] of a session and returns the updated session. */
    suspend fun respondToQuestion(sessionId: String, requestId: String, answers: QuestionAnswers): Session =
        send(
            "POST",
            buildUrl("sessions", sessionId, "respond-to-question"),
            encode(SessionRespondToQuestionInput(requestId, answers)),
            Session.serializer(),
        )

    /** Lists every runner (`runner.query`). */
    suspend fun listRunners(): List<Runner> =
        readAllPages(Runner.serializer()) { cursor -> buildListUrl("runners", cursor) }

    /** Lists every project (`project.query`). */
    suspend fun listProjects(): List<Project> =
        readAllPages(Project.serializer()) { cursor -> buildListUrl("projects", cursor) }

    /** Lists every assistant (`assistant.query`). */
    suspend fun listAssistants(): List<Assistant> =
        readAllPages(Assistant.serializer()) { cursor -> buildListUrl("assistants", cursor) }

    /**
     * Reads the newest [limit] messages of a conversation (`conversation.queryMessages`),
     * newest first.
     */
    suspend fun readNewestConversationMessages(conversationId: String, limit: Int): List<ConversationMessage> {
        val url = buildUrl("conversations", conversationId, "messages") {
            addQueryParameter("sort", "position:desc")
            addQueryParameter("limit", limit.toString())
        }
        return send("GET", url, null, Page.serializer(ConversationMessage.serializer())).items
    }

    /** Sends [text] to a conversation as the owner (`conversation.send`) and returns the stored message. */
    suspend fun sendConversationMessage(conversationId: String, text: String): ConversationMessage =
        send(
            "POST",
            buildUrl("conversations", conversationId, "messages"),
            encode(ConversationSendInput(text)),
            ConversationMessage.serializer(),
        )

    /**
     * Reads every page of a list operation and returns their items in order. [buildPageUrl]
     * builds the URL of one page from the previous page's `nextCursor`, or from null for the
     * first page; it must send the same sort and filters every time.
     */
    private suspend fun <T> readAllPages(
        itemSerializer: KSerializer<T>,
        buildPageUrl: (cursor: String?) -> HttpUrl,
    ): List<T> {
        val pageSerializer = Page.serializer(itemSerializer)
        val items = mutableListOf<T>()
        var cursor: String? = null
        do {
            val page = send("GET", buildPageUrl(cursor), null, pageSerializer)
            items += page.items
            cursor = page.nextCursor
        } while (cursor != null)
        return items
    }

    private fun buildListUrl(collection: String, cursor: String?): HttpUrl = buildUrl(collection) {
        addQueryParameter("limit", PAGE_LIMIT)
        if (cursor != null) addQueryParameter("cursor", cursor)
    }

    /**
     * Builds the URL `/api/v1/<path segments>` on [origin]. [first] may hold several segments
     * (`auth/login`); the ids that follow are each encoded as one segment.
     */
    private fun buildUrl(
        first: String,
        vararg ids: String,
        addQuery: HttpUrl.Builder.() -> Unit = {},
    ): HttpUrl = origin.newBuilder()
        .encodedPath("/api/v1/")
        .addPathSegments(first)
        .apply { ids.forEach(::addPathSegment) }
        .apply(addQuery)
        .build()

    private inline fun <reified T> encode(body: T): String = WireJson.encodeToString(body)

    /**
     * Sends one request and decodes a 200 reply with [serializer]. Any other status fails with
     * [ControllerApiException].
     */
    private suspend fun <T> send(
        method: String,
        url: HttpUrl,
        jsonBody: String?,
        serializer: DeserializationStrategy<T>,
        client: OkHttpClient = httpClient,
    ): T {
        val request = Request.Builder()
            .url(url)
            .method(method, jsonBody?.toRequestBody(JSON))
            .apply { if (bearerToken != null) header("Authorization", "Bearer $bearerToken") }
            .build()
        val reply = client.newCall(request).await()
        if (reply.status != HTTP_OK) throw ControllerApiException(decodeError(reply), reply.status)
        return WireJson.decodeFromString(serializer, reply.body)
    }

    /**
     * Decodes the error envelope of a failed reply. A body that is not an envelope, such as
     * a proxy's HTML page or a bare 413, becomes an `internal` error naming the HTTP status.
     */
    private fun decodeError(reply: HttpReply): ApiError = try {
        WireJson.decodeFromString(ApiErrorEnvelope.serializer(), reply.body).error
    } catch (_: SerializationException) {
        ApiError(ApiErrorCode.Internal, "The controller answered HTTP ${reply.status} without an error body.")
    }

    private companion object {
        const val HTTP_OK = 200
        const val PAGE_LIMIT = "500"
        const val SESSION_INPUT_READ_TIMEOUT_SECONDS = 150L
        const val EMPTY_OBJECT = "{}"
        val JSON = "application/json".toMediaType()
    }
}

/** A finished HTTP exchange: the status and the whole body as text. */
private class HttpReply(val status: Int, val body: String)

/**
 * Runs the call and returns its reply once the whole body has been read. Cancelling the
 * coroutine cancels the call. The body is read on OkHttp's own thread, so no coroutine blocks.
 */
private suspend fun Call.await(): HttpReply = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)

        override fun onResponse(call: Call, response: Response) {
            val reply = try {
                response.use { HttpReply(it.code, it.body.string()) }
            } catch (e: IOException) {
                continuation.resumeWithException(e)
                return
            }
            continuation.resume(reply)
        }
    })
}
