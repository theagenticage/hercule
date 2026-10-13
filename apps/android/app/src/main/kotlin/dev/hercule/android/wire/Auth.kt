package dev.hercule.android.wire

import kotlin.time.Instant
import kotlinx.serialization.Serializable

/** The body of `auth.login` (`POST /api/v1/auth/login`). */
@Serializable
data class LoginPayload(
    val username: String,
    val password: String,
)

/**
 * What `auth.login` returns. The token's expiry rolls forward on every use, and the
 * controller never reports the new one, so [expiresAt] is only the first value.
 */
@Serializable
data class LoginResult(
    val token: String,
    val expiresAt: Instant,
)

/** The body of `apiKey.create` (`POST /api/v1/api-keys`). */
@Serializable
data class ApiKeyCreateInput(val name: String)

/**
 * What `apiKey.create` returns. [token] appears here and nowhere else; the controller keeps
 * only its hash. [id] is what `apiKey.revoke` takes to end the key.
 */
@Serializable
data class MintedApiKey(
    val id: String,
    val name: String,
    val token: String,
    val createdAt: Instant,
)

/**
 * What `auth.wsTicket` (`POST /api/v1/auth/ws-ticket`, no body) returns: a single-use ticket,
 * valid for 5 minutes, for the live socket's `hello`.
 */
@Serializable
data class WsTicket(val ticket: String)

/** What `controller.read` (`GET /api/v1/controller`) returns, cut to what the app reads. */
@Serializable
data class ControllerInfo(
    val id: String,
    /** The build, such as `0.1.0+738cdb2b1`. The live socket's `hello` returns the same string. */
    val version: String,
    val defaultRunnerId: String?,
    val localRunnerId: String?,
)
