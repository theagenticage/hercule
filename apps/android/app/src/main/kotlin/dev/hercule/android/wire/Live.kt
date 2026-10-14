package dev.hercule.android.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * The payload of the live socket's `hello` request, the first request on every connection.
 * [ticket] comes from `auth.wsTicket` and works once.
 */
@Serializable
data class LiveHello(
    val v: Int,
    val ticket: String,
)

/** What `hello` returns. [serverVersion] is the same string as `controller.read`'s version. */
@Serializable
data class LiveHelloResult(
    val v: Int,
    val serverVersion: String,
)

/**
 * The payload of the live socket's `subscribe` request. [cursor] is sent only on a
 * `session:<id>:stream` or `event` topic, to replay what came after it.
 */
@Serializable
data class LiveSubscribe(
    val topic: String,
    val cursor: String? = null,
)

/**
 * What a mutable topic (`session`, `conversation`, `assistant`, `runner`, `notification`, ...)
 * pushes: the ids of the records that changed. The app then reads them again over HTTP.
 *
 * - Empty [ids] means every record of the topic may have changed. Every subscription's first
 *   message is one of these.
 * - On the `subagent` topic, [ids] are session ids.
 * - [conversationIds] is set only on the `session` topic: for each id in [ids], the
 *   conversation that session answers, or null for a session in no conversation.
 */
@Serializable
data class Invalidate(
    val ids: List<String>,
    val kind: InvalidateKind,
    val conversationIds: Map<String, String?>? = null,
)

/** How the records of an [Invalidate] changed. */
@Serializable
@JvmInline
value class InvalidateKind(val wire: String) {
    companion object {
        val Created = InvalidateKind("created")
        val Updated = InvalidateKind("updated")
        val Deleted = InvalidateKind("deleted")
    }
}

/**
 * What an append-only topic pushes. Its items carry no type field, so the subscriber decodes
 * them by the topic it subscribed to:
 *
 * - `session:<id>:stream`: [TranscriptRow]s; store [cursor] and send it back on resubscribe.
 * - `session:<id>:tap`: [TapItem]s; [cursor] is always null, because taps are never stored.
 * - `event`: event log records, not modelled here.
 */
@Serializable
data class Delta(
    val cursor: String? = null,
    val items: List<JsonElement>,
)

/**
 * One live token delta from a `session:<id>:tap` topic. Taps are never stored or replayed, so
 * deltas missed while disconnected are gone; the transcript holds the final text.
 */
@Serializable
data class TapItem(
    val turnId: String,
    val itemId: String,
    val streamKind: StreamKind,
    val delta: String,
    /** Set only on a subagent's tap. */
    val subagentId: String? = null,
)
