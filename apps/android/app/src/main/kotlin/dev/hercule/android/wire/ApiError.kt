package dev.hercule.android.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * The body of every failed HTTP response, and of a failed live socket request:
 * `{"error":{"code","message","details"?}}`.
 */
@Serializable
data class ApiErrorEnvelope(val error: ApiError)

/**
 * One error from the controller.
 *
 * `details` is absent for most codes. Its shape depends on the code: `validation` carries
 * `{"issues":[{"path":[...],"message":...}]}`, `forbidden` carries `{"grant":...}`, and
 * `controller_sealed` carries `{"newAddress":...}`. Show `message` to the user as it is.
 */
@Serializable
data class ApiError(
    val code: ApiErrorCode,
    val message: String,
    val details: JsonObject? = null,
)

/**
 * The code of an [ApiError]. The list only grows, so a code this build does not know decodes
 * to a value outside the constants below; the controller's guidance is to treat it as
 * [Internal]. Switch on the code, never on the HTTP status: three codes share 409.
 */
@Serializable
@JvmInline
value class ApiErrorCode(val wire: String) {
    companion object {
        val Unauthenticated = ApiErrorCode("unauthenticated")
        val Forbidden = ApiErrorCode("forbidden")
        val Validation = ApiErrorCode("validation")
        val NotFound = ApiErrorCode("not_found")
        val Conflict = ApiErrorCode("conflict")
        val InvalidState = ApiErrorCode("invalid_state")
        val ControllerSealed = ApiErrorCode("controller_sealed")
        val PromotionInProgress = ApiErrorCode("promotion_in_progress")
        val CapExceeded = ApiErrorCode("cap_exceeded")
        val ShrinkRejected = ApiErrorCode("shrink_rejected")
        val Internal = ApiErrorCode("internal")
    }
}
