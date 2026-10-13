package dev.hercule.android.wire

import kotlinx.serialization.json.Json

/**
 * The one JSON configuration every HTTP body and live socket payload goes through.
 *
 * - `ignoreUnknownKeys`: the controller's records grow by adding keys, and an older app
 *   must still read them.
 * - `explicitNulls = false`: a request field that is null is left out of the body instead of
 *   being sent as `null`. The session payloads refuse unknown keys and refuse `null` for an
 *   optional key, so a null must never reach the wire. On decode, this setting also reads a
 *   missing key as null for a nullable field, so a field the contract declares as "always
 *   present, may be null" decodes the same whether the key is there or not.
 *
 * Fields with a default are not encoded while they hold it (the library's default), which
 * keeps optional request fields out of the body unless they are set.
 */
val WireJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}
